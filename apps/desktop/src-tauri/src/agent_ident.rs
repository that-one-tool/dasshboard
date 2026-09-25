//! SSH-agent identity enumeration (spike prototype for hardware-token auth).
//!
//! Unlike `agent.rs` — which forwards an agent channel as a *verbatim byte copy*
//! for `ssh -A` — this module speaks the agent protocol itself, via russh-keys'
//! `AgentClient`, to answer one question: **which public keys does the local
//! agent hold?** — and to hand a live connection to the auth path
//! (`connect_agent_for_auth` → `session.rs` → `authenticate_publickey_with`): the
//! agent owns the token and performs the touch/PIN/PKCS#11 work, so we only ever
//! see public keys and relayed signatures, never key material.
//!
//! Transport:
//! - Unix: `$SSH_AUTH_SOCK`.
//! - Windows: each candidate agent *named pipe* in turn (see
//!   `windows_agent_pipes`) — an explicit `$SSH_AUTH_SOCK`, the default OpenSSH
//!   agent pipe, then any running Pageant instance's pipe. All speak the same
//!   agent wire protocol; the WM_COPYDATA Pageant path is deliberately not used
//!   (the spike found it returns `early eof` against current Pageant).
//!
//! Note: identities come from russh's *own* bundled `keys::agent` module (the
//! `russh::keys` re-export), not the standalone `russh-keys` crate — its
//! `request_identities` yields `AgentIdentity` (public key **or** OpenSSH
//! certificate) and preserves the per-key comment, so we label a key by
//! algorithm + comment + SHA256 fingerprint, matching `ssh-add -l`.

use std::time::Duration;

use serde::Serialize;

use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::agent::AgentIdentity;
use russh::keys::ssh_key::{Algorithm, HashAlg, PublicKey};

#[cfg(windows)]
use crate::agent::WINDOWS_AGENT_PIPE;
use crate::error::AppError;

/// Deadline for a single agent connect+enumerate attempt. russh's
/// `connect_named_pipe` retries `ERROR_PIPE_BUSY` in an *unbounded* loop and its
/// reads have no deadline of their own, so a busy or silent pipe (including a
/// hostile local one — see `windows_agent_pipes`) would otherwise hang the call
/// forever. On Windows each candidate pipe gets its own budget and a timeout is
/// treated as just another failed candidate.
const AGENT_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(5);

/// One public key the local agent is holding, in a shape the frontend can list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentIdentityInfo {
    /// SSH algorithm name, e.g. `ssh-ed25519`, `sk-ssh-ed25519@openssh.com`.
    pub algorithm: String,
    /// SHA256 fingerprint, `SHA256:…` — the stable id we would persist on a
    /// device to say "authenticate with this agent key".
    pub fingerprint: String,
    /// True for FIDO/U2F security keys (`sk-*`). A UI hint only; a PIV/PKCS#11
    /// smartcard key still reports its underlying algorithm (ecdsa/rsa) and is
    /// not flagged here — "hardware" via the agent is broader than just `sk-*`.
    pub is_security_key: bool,
    /// The agent's comment for this identity (often the original key file path
    /// or a label like `yubikey`). May be empty.
    pub comment: String,
    /// True when the identity is an OpenSSH certificate rather than a bare key.
    pub is_certificate: bool,
    /// The full `ssh-…`/`sk-…` one-line public key (or certificate). Kept so a
    /// future auth path can match the stored identity back to an agent key.
    pub openssh: String,
}

impl AgentIdentityInfo {
    fn from_identity(identity: &AgentIdentity) -> Result<Self, AppError> {
        let enc_err = |e| AppError::SshChannel(format!("could not encode agent identity: {e}"));
        match identity {
            AgentIdentity::PublicKey { key, comment } => {
                let algorithm = key.algorithm();
                Ok(Self {
                    algorithm: algorithm.as_str().to_string(),
                    fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
                    is_security_key: is_sk(&algorithm),
                    comment: comment.clone(),
                    is_certificate: false,
                    openssh: key.to_openssh().map_err(enc_err)?,
                })
            }
            AgentIdentity::Certificate {
                certificate,
                comment,
            } => {
                // The cert's own algorithm is `*-cert-v01@openssh.com`; classify
                // sk-ness from the *underlying* key so an sk-backed certificate
                // is still flagged as a security key.
                Ok(Self {
                    algorithm: certificate.algorithm().as_str().to_string(),
                    fingerprint: certificate
                        .public_key()
                        .fingerprint(HashAlg::Sha256)
                        .to_string(),
                    is_security_key: is_sk(&certificate.public_key().algorithm()),
                    comment: comment.clone(),
                    is_certificate: true,
                    openssh: certificate.to_openssh().map_err(enc_err)?,
                })
            }
        }
    }
}

/// FIDO/U2F security-key algorithms (`sk-*`).
fn is_sk(algorithm: &Algorithm) -> bool {
    matches!(
        algorithm,
        Algorithm::SkEcdsaSha2NistP256 | Algorithm::SkEd25519
    )
}

/// A live agent connection plus the identities it advertised. Held so the same
/// connection that enumerated the keys is the one used to sign during auth. The
/// transport is boxed (`dynamic()`) so both platforms' concrete pipe/socket
/// types collapse to one signer type for `authenticate_publickey_with`.
pub struct AgentAuth {
    pub client: AgentClient<Box<dyn AgentStream + Send + Unpin>>,
    pub identities: Vec<AgentIdentity>,
}

/// Box the transport and read the identity list off a freshly-connected client.
async fn read_identities<S>(client: AgentClient<S>) -> Result<AgentAuth, AppError>
where
    S: AgentStream + Send + Unpin + 'static,
{
    let mut client = client.dynamic();
    let identities = client
        .request_identities()
        .await
        .map_err(|e| AppError::SshChannel(format!("could not list agent identities: {e}")))?;
    Ok(AgentAuth { client, identities })
}

/// Find the public key of the identity whose SHA256 fingerprint matches
/// `fingerprint` (as produced by [`AgentIdentityInfo`]). Certificates are not
/// yet supported for agent auth (a different russh method) — they are skipped,
/// so a cert-only match returns `None` with the same "identity not held" error
/// as a genuinely absent key.
pub fn find_public_key(identities: &[AgentIdentity], fingerprint: &str) -> Option<PublicKey> {
    identities.iter().find_map(|id| match id {
        AgentIdentity::PublicKey { key, .. }
            if key.fingerprint(HashAlg::Sha256).to_string() == fingerprint =>
        {
            Some(key.clone())
        }
        _ => None,
    })
}

/// List the identities held by the local SSH agent (drops the live connection).
///
/// Errors (secret-free, `SshChannel`) when no agent is reachable. An empty `Vec`
/// means the agent is up but holds no keys — a normal, distinct outcome.
pub async fn list_agent_identities() -> Result<Vec<AgentIdentityInfo>, AppError> {
    let auth = connect_agent().await?;
    auth.identities
        .iter()
        .map(AgentIdentityInfo::from_identity)
        .collect()
}

/// Connect to the local SSH agent for authentication, returning the live
/// connection and the identities it holds. Same discovery/selection as
/// [`list_agent_identities`]; the caller matches an identity by fingerprint and
/// uses `client` as the signer.
pub async fn connect_agent_for_auth() -> Result<AgentAuth, AppError> {
    connect_agent().await
}

/// Unix: connect the `$SSH_AUTH_SOCK` agent, bounded by [`AGENT_ATTEMPT_TIMEOUT`].
#[cfg(unix)]
async fn connect_agent() -> Result<AgentAuth, AppError> {
    let attempt = async {
        let client = AgentClient::connect_env().await.map_err(|e| {
            AppError::SshChannel(format!("could not connect to the SSH agent: {e}"))
        })?;
        read_identities(client).await
    };
    tokio::time::timeout(AGENT_ATTEMPT_TIMEOUT, attempt)
        .await
        .map_err(|_| AppError::SshChannel("the SSH agent did not respond in time".to_string()))?
}

/// Cap on discovered Pageant pipes tried, so a machine littered with stale (or
/// maliciously-created) `pageant.*` pipes can't turn a connect into an
/// `N × AGENT_ATTEMPT_TIMEOUT` stall. One live Pageant is the norm; a handful
/// covers a second session.
#[cfg(windows)]
const MAX_PAGEANT_PIPES: usize = 8;

/// Windows: try each candidate agent named pipe in priority order and return the
/// first live connection worth using. All Windows agents worth supporting speak
/// the standard agent protocol over a named pipe:
/// - an explicit `$SSH_AUTH_SOCK` (user override),
/// - the default OpenSSH agent pipe,
/// - any running Pageant instance's `pageant.<user>.<hash>` pipe.
///
/// The spike found russh's WM_COPYDATA `connect_pageant()` returns `early eof`
/// against Pageant 0.84, so Pageant is reached through its named pipe instead.
///
/// A connection with **keys** wins immediately. One that answers with *no* keys
/// is remembered but does not stop the search, so a stale/empty pipe earlier in
/// the list can't mask a populated agent later (multiple `pageant.*` pipes are
/// discovered in arbitrary order). If every reachable agent is empty we return
/// the (empty) first; only if none answers do we error, per-pipe failures joined.
///
/// SECURITY: a named pipe does not authenticate its server, and any local process
/// can create `\\.\pipe\pageant.*` (or squat `openssh-ssh-agent` when the real
/// service is down). We do **not** try to verify the pipe's owner: the real
/// OpenSSH agent runs as Local System and a foreign process can't be opened for
/// inspection anyway, so such a check is unreliable and gives false assurance.
/// Instead the guarantee is that auth is **fail-safe** — a fake or foreign agent
/// cannot produce a signature the real server accepts without the private key, so
/// the worst a squatter achieves is a failed attempt or a spoofed picker label,
/// never a wrong successful login. Canonical pipes are still preferred by order.
#[cfg(windows)]
async fn connect_agent() -> Result<AgentAuth, AppError> {
    // Discovery does a blocking directory read; keep it off the async worker.
    let candidates = tokio::task::spawn_blocking(windows_agent_pipes)
        .await
        .map_err(|e| AppError::SshChannel(format!("pipe discovery task failed: {e}")))?;

    let mut errors = Vec::new();
    let mut empty_agent: Option<AgentAuth> = None;
    for pipe in &candidates {
        match try_pipe(pipe).await {
            Ok(auth) if auth.identities.is_empty() => {
                empty_agent.get_or_insert(auth);
            }
            Ok(auth) => return Ok(auth),
            Err(e) => errors.push(format!("{pipe}: {e}")),
        }
    }
    if let Some(auth) = empty_agent {
        return Ok(auth);
    }
    Err(AppError::SshChannel(if errors.is_empty() {
        "no SSH agent reachable: no agent named pipe found".to_string()
    } else {
        format!(
            "no SSH agent reachable via named pipe ({})",
            errors.join("; ")
        )
    }))
}

/// Connect one candidate pipe and enumerate it, under a single bounded deadline
/// (see [`AGENT_ATTEMPT_TIMEOUT`]). Any failure (including a timeout) is returned
/// as an error so the caller moves on to the next candidate.
#[cfg(windows)]
async fn try_pipe(pipe: &str) -> Result<AgentAuth, AppError> {
    let attempt = async {
        let client = AgentClient::connect_named_pipe(pipe)
            .await
            .map_err(|e| AppError::SshChannel(format!("connect: {e}")))?;
        read_identities(client).await
    };
    tokio::time::timeout(AGENT_ATTEMPT_TIMEOUT, attempt)
        .await
        .map_err(|_| AppError::SshChannel("timed out".to_string()))?
}

/// Candidate agent named pipes on Windows, in priority order and de-duplicated:
/// an explicit `$SSH_AUTH_SOCK`, the default OpenSSH agent pipe, then any
/// discovered Pageant pipes (`\\.\pipe\pageant.*`, capped at [`MAX_PAGEANT_PIPES`]).
/// Pageant's pipe carries a per-instance hash, so it must be discovered by listing
/// `\\.\pipe\` rather than named by a constant. Enumeration failures are ignored —
/// a missing or unreadable pipe directory just yields fewer candidates.
///
/// Blocking (`std::fs::read_dir`); callers run it via `spawn_blocking`.
#[cfg(windows)]
fn windows_agent_pipes() -> Vec<String> {
    let sock = std::env::var("SSH_AUTH_SOCK").ok();

    // Discover Pageant instances. Pageant names its pipe
    // `pageant.<user>.<sha256hex>`; there is normally one, but a stale entry or
    // a second session could leave several, so collect a bounded number.
    let mut pageant_pipes = Vec::new();
    if let Ok(entries) = std::fs::read_dir(r"\\.\pipe\") {
        for entry in entries.flatten() {
            if pageant_pipes.len() >= MAX_PAGEANT_PIPES {
                break;
            }
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with("pageant.") {
                    pageant_pipes.push(format!(r"\\.\pipe\{name}"));
                }
            }
        }
    }
    windows_agent_pipes_from(sock, pageant_pipes)
}

/// Pure candidate-assembly logic, split out so it is unit-testable without
/// mutating process-global `$SSH_AUTH_SOCK` or touching the pipe filesystem.
/// De-dup is case-insensitive because Windows pipe names are: an explicit
/// `$SSH_AUTH_SOCK` leads, then the default OpenSSH pipe, then Pageant pipes.
#[cfg(windows)]
fn windows_agent_pipes_from(sock: Option<String>, pageant_pipes: Vec<String>) -> Vec<String> {
    let mut pipes: Vec<String> = Vec::new();
    let push = |pipe: String, pipes: &mut Vec<String>| {
        if !pipe.is_empty() && !pipes.iter().any(|p| p.eq_ignore_ascii_case(&pipe)) {
            pipes.push(pipe);
        }
    };

    if let Some(sock) = sock {
        push(sock, &mut pipes);
    }
    push(WINDOWS_AGENT_PIPE.to_string(), &mut pipes);
    for p in pageant_pipes {
        push(p, &mut pipes);
    }
    pipes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn list_is_a_result_without_panicking() {
        // The test host may or may not run an agent; either branch is valid. We
        // only assert the call completes and, if it succeeds, that each
        // identity's shape is well-formed. No key material is asserted on.
        if let Ok(ids) = list_agent_identities().await {
            for id in ids {
                assert!(id.fingerprint.starts_with("SHA256:"));
                assert!(!id.algorithm.is_empty());
            }
        }
    }

    /// Candidate assembly (pure): explicit sock first, the OpenSSH default is
    /// always present, Pageant pipes follow, and de-dup is case-insensitive so a
    /// differently-cased `$SSH_AUTH_SOCK` for the default pipe collapses. No
    /// process-global env is touched.
    #[cfg(windows)]
    #[test]
    fn windows_pipes_from_orders_and_dedups() {
        // Explicit sock naming the default pipe (upper-cased) must not duplicate.
        let pipes = windows_agent_pipes_from(
            Some(WINDOWS_AGENT_PIPE.to_uppercase()),
            vec![r"\\.\pipe\pageant.me.abc".to_string()],
        );
        assert_eq!(pipes.len(), 2, "case-insensitive dedup of the default pipe");
        assert!(pipes[0].eq_ignore_ascii_case(WINDOWS_AGENT_PIPE));
        assert_eq!(pipes[1], r"\\.\pipe\pageant.me.abc");

        // No sock: default pipe leads, Pageant pipes follow.
        let pipes = windows_agent_pipes_from(None, vec![r"\\.\pipe\pageant.me.abc".to_string()]);
        assert_eq!(
            pipes,
            vec![
                WINDOWS_AGENT_PIPE.to_string(),
                r"\\.\pipe\pageant.me.abc".to_string()
            ]
        );
    }
}
