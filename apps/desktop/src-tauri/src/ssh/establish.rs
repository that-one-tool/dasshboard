//! Reaching and authenticating to an SSH server, directly or through one jump
//! host — the one connect path shells, tunnels and SFTP share.

use std::sync::Arc;
use std::time::Duration;

use russh::client;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::time::timeout;
use zeroize::Zeroizing;

use super::handler::SshHandler;
use super::params::{AuthCredentials, Endpoint, JumpHop};
use crate::error::AppError;

/// Default connect (TCP + handshake reachability) timeout — SPEC.md §6.
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Default host-key trust-prompt timeout — SPEC.md §6 (reject on elapse).
pub const DEFAULT_PROMPT_TIMEOUT: Duration = Duration::from_secs(60);
/// Default slack budgeted for the SSH version exchange/KEX and the
/// authentication exchange, on top of whatever `DEFAULT_CONNECT_TIMEOUT` and
/// `DEFAULT_PROMPT_TIMEOUT` already cover (B3). Together they form the
/// overall `establish` deadline — see `SessionManager::overall_establish_timeout`.
pub const DEFAULT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);

/// Maps a russh handshake/transport error to the right `AppError` code.
fn map_connect_err(err: russh::Error) -> AppError {
    match err {
        // Emitted when `check_server_key` returned false (reject/timeout/close).
        russh::Error::UnknownKey => {
            AppError::HostKeyRejected("the host key was not trusted".to_string())
        }
        other => AppError::SshConnect(format!("SSH handshake failed: {other}")),
    }
}

/// Connect + authenticate (no shell). Tauri-free; used by both the live
/// session task and `test_connection`. `connect_timeout` bounds only reaching
/// the host (TCP connect); the subsequent handshake may legitimately block on
/// the host-key prompt, which has its own cap inside the handler. Callers
/// needing an overall bound on the whole flow (B3) should go through
/// [`establish_with_deadline`] instead of calling this directly.
async fn establish(
    host: &str,
    port: u16,
    username: &str,
    creds: &AuthCredentials,
    handler: SshHandler,
    connect_timeout: Duration,
) -> Result<client::Handle<SshHandler>, AppError> {
    let stream = connect_tcp(host, port, connect_timeout).await?;
    establish_over_stream(stream, username, creds, handler).await
}

/// Reach `host:port` within `connect_timeout`. Nagle is turned off (as
/// OpenSSH does): with it, each keystroke waits for the previous one's ACK,
/// a full round trip on a slow link.
async fn connect_tcp(
    host: &str,
    port: u16,
    connect_timeout: Duration,
) -> Result<TcpStream, AppError> {
    let stream = match timeout(connect_timeout, TcpStream::connect((host, port))).await {
        Err(_) => {
            return Err(AppError::SshConnect(format!(
                "connection to {host}:{port} timed out"
            )))
        }
        Ok(Err(e)) => {
            return Err(AppError::SshConnect(format!(
                "could not connect to {host}:{port}: {e}"
            )))
        }
        Ok(Ok(stream)) => stream,
    };
    // Best-effort: a socket that refuses it still works, only slower.
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

/// The transport-agnostic half of [`establish`]: run the SSH version exchange,
/// key exchange and authentication over an already-connected byte stream, then
/// return the authenticated client handle. Used directly (over a `TcpStream`)
/// by [`establish`] and over a jump host's direct-tcpip channel by
/// [`connect_through_jump`], so the host-key-TOFU handler path is identical for a
/// direct and a jumped connection. Error messages describe only the
/// format/crypto problem, never secret material.
async fn establish_over_stream<S>(
    stream: S,
    username: &str,
    creds: &AuthCredentials,
    handler: SshHandler,
) -> Result<client::Handle<SshHandler>, AppError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    // Keepalive is driven natively by russh (see `KeepaliveConfig`); no
    // inactivity GC. Read it off the handler before it is moved into
    // `connect_stream`.
    let keepalive = handler.keepalive;
    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: keepalive.interval,
        keepalive_max: keepalive.max,
        ..Default::default()
    });

    let mut handle = client::connect_stream(config, stream, handler)
        .await
        .map_err(map_connect_err)?;

    let auth_result = match creds {
        AuthCredentials::Password(password) => handle
            .authenticate_password(username, password.clone())
            .await
            .map_err(|e| AppError::SshAuth(format!("password authentication error: {e}")))?,
        AuthCredentials::Key { path, passphrase } => {
            // Key/passphrase failures describe the format/crypto problem only,
            // never the passphrase or key bytes. Loading an OpenSSH key runs a
            // deliberately CPU-expensive KDF (bcrypt_pbkdf) for a
            // passphrase-protected key plus a synchronous file read, so it runs
            // on `spawn_blocking` rather than stalling this async connect path
            // (and, in Phase 3, unrelated sessions sharing the runtime).
            let path = path.clone();
            let passphrase = Zeroizing::new(passphrase.clone());
            let key =
                tokio::task::spawn_blocking(move || load_secret_key(&path, passphrase.as_deref()))
                    .await
                    .map_err(|e| AppError::SshAuth(format!("key-load task failed: {e}")))?
                    .map_err(|e| AppError::SshAuth(format!("could not load key file: {e}")))?;
            let hash = handle
                .best_supported_rsa_hash()
                .await
                .ok()
                .flatten()
                .flatten();
            handle
                .authenticate_publickey(username, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await
                .map_err(|e| AppError::SshAuth(format!("publickey authentication error: {e}")))?
        }
        AuthCredentials::Agent { fingerprint } => {
            // Connect to the local agent, find the user-selected identity by its
            // (public) fingerprint, and delegate signing to the agent. The agent
            // — possibly a hardware token — owns the key; we only relay the
            // challenge/response, so no key material passes through this process.
            // A hostile/spoofed agent cannot succeed here: it would have to
            // produce a signature the server accepts without the private key.
            let mut agent = crate::agent_ident::connect_agent_for_auth().await?;
            let public = crate::agent_ident::find_public_key(&agent.identities, fingerprint)
                .ok_or_else(|| {
                    AppError::SshAuth(
                        "the SSH agent does not hold the selected identity — is the token \
                         plugged in and unlocked?"
                            .to_string(),
                    )
                })?;
            // RSA agent keys need an explicit signature-hash negotiation; other
            // key types (ed25519, ecdsa, sk-*) ignore it.
            let hash = if public.algorithm().is_rsa() {
                handle
                    .best_supported_rsa_hash()
                    .await
                    .ok()
                    .flatten()
                    .flatten()
            } else {
                None
            };
            handle
                .authenticate_publickey_with(username, public, hash, &mut agent.client)
                .await
                .map_err(|e| AppError::SshAuth(format!("agent authentication error: {e}")))?
        }
    };

    if !auth_result.success() {
        return Err(AppError::SshAuth(
            "authentication failed — check the stored password/key and the username".to_string(),
        ));
    }

    Ok(handle)
}

/// Wrap [`establish`] with an overall deadline covering the ENTIRE
/// handshake+auth flow — not just the TCP connect `establish` already bounds
/// internally (B3). A host that accepts TCP but never speaks SSH, or stalls
/// mid-auth, is therefore always bounded. `overall_timeout` must be sized
/// generously above the prompt-wait cap so a connection legitimately waiting
/// on the host-key prompt is never cut off early — see
/// `SessionManager::overall_establish_timeout`, which builds it from
/// `connect_timeout + prompt_timeout + handshake_timeout`.
async fn establish_with_deadline(
    host: &str,
    port: u16,
    username: &str,
    creds: &AuthCredentials,
    handler: SshHandler,
    connect_timeout: Duration,
    overall_timeout: Duration,
) -> Result<client::Handle<SshHandler>, AppError> {
    match timeout(
        overall_timeout,
        establish(host, port, username, creds, handler, connect_timeout),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(AppError::SshConnect(format!(
            "connecting to {host}:{port} timed out during the SSH handshake or authentication"
        ))),
    }
}

/// Prefix a hop-1 (jump host) failure with the jump host's identity, preserving
/// the error kind, so an auth/connect/host-key failure *at the jump host* is not
/// mistaken for one at the target. Without this both hops funnel through the
/// same generic `establish_over_stream` messages and the user checks the wrong
/// device's credentials.
fn annotate_jump_error(err: AppError, host: &str, port: u16) -> AppError {
    match err {
        AppError::SshAuth(m) => AppError::SshAuth(format!("jump host {host}:{port}: {m}")),
        AppError::SshConnect(m) => AppError::SshConnect(format!("jump host {host}:{port}: {m}")),
        AppError::HostKeyRejected(m) => {
            AppError::HostKeyRejected(format!("jump host {host}:{port}: {m}"))
        }
        other => other,
    }
}

/// Connect to the target through a single jump host (`ProxyJump`): authenticate
/// to the jump host, ask it to open a direct-tcpip channel to the target, then
/// run the target's SSH handshake over that channel as a byte stream. Returns
/// both handles; the jump handle must be kept alive for the connection's
/// lifetime (dropping it tears down the channel the target rides on). Only the
/// TCP connect to the jump host is bounded here (by `connect_timeout`); the
/// caller wraps this whole function in the single overall deadline (see
/// `establish_target`), which is what bounds the channel-open and the target
/// handshake too.
async fn connect_through_jump(
    target: &Endpoint<'_>,
    target_handler: SshHandler,
    jump: &JumpHop,
    connect_timeout: Duration,
) -> Result<(client::Handle<SshHandler>, client::Handle<SshHandler>), AppError> {
    // Hop 1: connect + authenticate to the jump host (its own host-key TOFU
    // prompt, since its handler carries the jump host's addr). Errors are
    // attributed to the jump host. The owner token lives in this future, so
    // dropping it abandons a pending jump-host prompt.
    let mut jump_handler = target_handler.for_jump_host(jump);
    let _jump_owner = jump_handler.take_owner_token();
    let jump_handle = establish(
        &jump.host,
        jump.port,
        &jump.username,
        &jump.creds,
        jump_handler,
        connect_timeout,
    )
    .await
    .map_err(|e| annotate_jump_error(e, &jump.host, jump.port))?;

    // Hop 2: ask the jump host to open a TCP connection to the target, then run
    // the target's SSH handshake over that channel.
    let channel = jump_handle
        .channel_open_direct_tcpip(target.host, target.port as u32, "127.0.0.1", 0)
        .await
        .map_err(|e| {
            AppError::SshConnect(format!(
                "jump host could not open a channel to {}:{}: {e}",
                target.host, target.port
            ))
        })?;

    let target_handle = establish_over_stream(
        channel.into_stream(),
        target.username,
        target.creds,
        target_handler,
    )
    .await?;

    Ok((target_handle, jump_handle))
}

/// Establish a connection to `target`, either directly or through a single
/// jump host (`ProxyJump`) — the one connect path shells, tunnels and SFTP
/// share. Returns the authenticated target handle plus, for a jumped
/// connection, the jump host's handle — which the caller **must keep alive**
/// for as long as it uses the target, since dropping it tears down the
/// direct-tcpip channel the target rides on (then [`close_jump`] it).
pub(crate) async fn establish_target(
    target: Endpoint<'_>,
    jump: Option<&JumpHop>,
    target_handler: SshHandler,
    connect_timeout: Duration,
    overall_timeout: Duration,
) -> Result<
    (
        client::Handle<SshHandler>,
        Option<client::Handle<SshHandler>>,
    ),
    AppError,
> {
    let Some(jump) = jump else {
        let handle = establish_with_deadline(
            target.host,
            target.port,
            target.username,
            target.creds,
            target_handler,
            connect_timeout,
            overall_timeout,
        )
        .await?;
        return Ok((handle, None));
    };
    // A SINGLE overall deadline covers the whole two-hop establish — both
    // handshakes AND the channel-open between them — so a jumped connect can
    // never exceed the same budget a direct one gets, and a jump host that
    // accepts but black-holes the channel-open to an unreachable target can't
    // hang the connection in "Connecting".
    match timeout(
        overall_timeout,
        connect_through_jump(&target, target_handler, jump, connect_timeout),
    )
    .await
    {
        Ok(Ok((target_handle, jump_handle))) => Ok((target_handle, Some(jump_handle))),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(AppError::SshConnect(format!(
            "connecting to {}:{} through jump host {}:{} timed out",
            target.host, target.port, jump.host, jump.port
        ))),
    }
}

/// Close the jump host's connection (if any) once the target riding on it has
/// been disconnected. Best-effort, like every other teardown.
pub(crate) async fn close_jump(jump: Option<&client::Handle<SshHandler>>) {
    if let Some(jump) = jump {
        let _ = jump
            .disconnect(russh::Disconnect::ByApplication, "", "")
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_ssh_socket_sends_small_writes_without_delay() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();

        let stream = connect_tcp("127.0.0.1", port, Duration::from_secs(5))
            .await
            .expect("connects");

        assert!(
            stream.nodelay().unwrap(),
            "Nagle must be off for keystrokes"
        );
    }
}
