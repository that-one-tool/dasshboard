//! Local SSH agent connection for agent forwarding (`ssh -A`).
//!
//! When agent forwarding is enabled on a session, the remote server opens an
//! `auth-agent@openssh.com` channel back to us every time a program on the
//! server wants to use our keys (`git push`, a further `ssh` hop, …). That
//! channel carries the raw ssh-agent wire protocol — and so does this machine's
//! agent socket/pipe — so forwarding is a *verbatim byte copy* between the two,
//! exactly as OpenSSH's own `ssh -A` does. The app never parses or interprets
//! the agent protocol, and **no key material ever passes through the app** (the
//! agent signs on the server's behalf; only signatures cross the wire).
//!
//! Platform transport:
//! - Unix: the domain socket named by `$SSH_AUTH_SOCK`.
//! - Windows: `$SSH_AUTH_SOCK` if set, else the default OpenSSH agent named pipe
//!   `\\.\pipe\openssh-ssh-agent`.

use tokio::io::{AsyncRead, AsyncWrite};

use crate::error::AppError;

/// The default Windows OpenSSH agent named pipe, used when `SSH_AUTH_SOCK` is
/// unset (the common case — Windows OpenSSH doesn't export it).
#[cfg(windows)]
const WINDOWS_AGENT_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";

/// A connected byte stream to the local SSH agent. Boxed so the per-platform
/// transport (Unix domain socket vs Windows named pipe) doesn't leak into the
/// caller, which only ever copies bytes to and from it.
pub type AgentStream = Box<dyn AgentStreamIo>;

/// Marker for the I/O a forwarded agent channel is copied against. Blanket-
/// implemented for every async byte stream so both platforms' concrete types
/// (`UnixStream`, `NamedPipeClient`) satisfy it without extra glue.
pub trait AgentStreamIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> AgentStreamIo for T {}

/// Connect to this machine's SSH agent, returning a raw byte stream that speaks
/// the ssh-agent protocol. Errors (mapped to `SshChannel`, which is secret-free)
/// when no agent is reachable — the caller logs and drops the one forwarded
/// channel; the session itself is unaffected.
#[cfg(unix)]
pub async fn connect_agent() -> Result<AgentStream, AppError> {
    let sock = std::env::var("SSH_AUTH_SOCK")
        .ok()
        .filter(|s| !s.is_empty());
    let Some(sock) = sock else {
        return Err(AppError::SshChannel(
            "agent forwarding is on but no SSH agent is running (SSH_AUTH_SOCK is unset)"
                .to_string(),
        ));
    };
    let stream = tokio::net::UnixStream::connect(&sock)
        .await
        .map_err(|e| AppError::SshChannel(format!("could not connect to the SSH agent: {e}")))?;
    Ok(Box::new(stream))
}

/// Windows variant: connect the OpenSSH agent named pipe (see module docs).
#[cfg(windows)]
pub async fn connect_agent() -> Result<AgentStream, AppError> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let path = std::env::var("SSH_AUTH_SOCK")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| WINDOWS_AGENT_PIPE.to_string());
    // `ClientOptions::open` is synchronous but non-blocking (it opens an existing
    // pipe instance); an error means the agent service isn't running.
    let client = ClientOptions::new().open(&path).map_err(|e| {
        AppError::SshChannel(format!("could not connect to the SSH agent at {path}: {e}"))
    })?;
    Ok(Box::new(client))
}

/// Best-effort check of whether a local SSH agent is reachable, for a UI hint
/// (the "Forward SSH agent" toggle stays usable regardless — forwarding simply
/// no-ops per channel if the agent turns out to be unavailable at connect time).
#[cfg(unix)]
pub fn agent_available() -> bool {
    std::env::var("SSH_AUTH_SOCK")
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}

/// Windows variant: an explicit `SSH_AUTH_SOCK`, or the default agent pipe
/// existing (the OpenSSH Authentication Agent service is running).
#[cfg(windows)]
pub fn agent_available() -> bool {
    if std::env::var("SSH_AUTH_SOCK")
        .map(|s| !s.is_empty())
        .unwrap_or(false)
    {
        return true;
    }
    // A named pipe shows up under \\.\pipe\; metadata succeeds when a server
    // instance exists. Best-effort only — a false negative just hides the hint.
    std::fs::metadata(WINDOWS_AGENT_PIPE).is_ok()
}

/// Relay one forwarded agent channel to the local agent: connect a fresh agent
/// stream and copy bytes both ways until either side closes. Spawned as its own
/// task per channel (agent channels are short-lived — one signing exchange).
/// All failures are logged (never with secret material) and end only this one
/// channel, since a forwarded-agent hiccup must never tear down the shell.
pub async fn proxy_agent_channel<S>(channel_stream: S)
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    let mut agent = match connect_agent().await {
        Ok(agent) => agent,
        Err(err) => {
            eprintln!("[DaSSHboard] agent forwarding: {err}");
            return;
        }
    };
    let mut channel_stream = channel_stream;
    if let Err(err) = tokio::io::copy_bidirectional(&mut channel_stream, &mut agent).await {
        // A reset when either end finishes is normal; log at a low key.
        eprintln!("[DaSSHboard] agent forwarding channel ended: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_available_is_a_pure_env_check_on_unix() {
        // Just assert it runs and returns a bool without panicking; the exact
        // value depends on the test host's environment.
        let _ = agent_available();
    }
}
