//! Reaching and authenticating to an SSH server, directly or through one jump
//! host — the one connect path shells, tunnels and SFTP share.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, AuthResult, KeyboardInteractiveAuthResponse};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use tokio::io::{AsyncRead, AsyncWrite, DuplexStream};
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio::time::timeout;
use zeroize::Zeroizing;

use super::deadline::ConnectDeadline;
use super::handler::SshHandler;
use super::interactive_auth::{finish_authentication, KbdTransport};
use super::params::{AuthCredentials, Endpoint, JumpHop};
use crate::error::AppError;
use crate::relay::{bridge_until_either_ends, Pace};

/// Default connect (TCP + handshake reachability) timeout — SPEC.md §6.
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Default host-key trust-prompt timeout — SPEC.md §6 (reject on elapse).
pub const DEFAULT_PROMPT_TIMEOUT: Duration = Duration::from_secs(60);
/// How long closing a jump host waits for the target riding it to get its
/// own disconnect through first.
const TARGET_CLOSE_GRACE: Duration = Duration::from_millis(250);

/// Default slack budgeted for the SSH version exchange/KEX and the
/// authentication exchange, on top of whatever `DEFAULT_CONNECT_TIMEOUT` and
/// `DEFAULT_PROMPT_TIMEOUT` already cover (B3). Together they form the
/// overall `establish` deadline — see `overall_establish_timeout`.
pub const DEFAULT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);

/// Overall deadline for one establish (B3), both hops of a jumped one
/// included. Time spent on a prompt doesn't count (see `ConnectDeadline`);
/// the prompt allowance is kept as slack for slow links.
pub(crate) fn overall_establish_timeout(
    connect: Duration,
    prompt: Duration,
    handshake: Duration,
) -> Duration {
    connect + prompt + handshake
}

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

    let asker = handler.auth_asker(username);
    let mut handle = client::connect_stream(config, stream, handler)
        .await
        .map_err(map_connect_err)?;

    let first = authenticate_configured(&mut handle, username, creds).await?;
    finish_authentication(
        &mut handle,
        username,
        first,
        creds.method_kind(),
        creds.saved_password(),
        &asker,
    )
    .await?;
    Ok(handle)
}

/// Try the device's configured auth method once. Errors describe only the
/// format/crypto problem, never secret material.
async fn authenticate_configured(
    handle: &mut client::Handle<SshHandler>,
    username: &str,
    creds: &AuthCredentials,
) -> Result<AuthResult, AppError> {
    match creds {
        AuthCredentials::Password(password) => handle
            .authenticate_password(username, password.clone())
            .await
            .map_err(|e| AppError::SshAuth(format!("password authentication error: {e}"))),
        AuthCredentials::Key { path, passphrase } => {
            authenticate_with_key(handle, username, path, passphrase).await
        }
        AuthCredentials::Agent { fingerprint } => {
            authenticate_with_agent(handle, username, fingerprint).await
        }
    }
}

async fn authenticate_with_key(
    handle: &mut client::Handle<SshHandler>,
    username: &str,
    path: &str,
    passphrase: &Option<String>,
) -> Result<AuthResult, AppError> {
    // Loading an OpenSSH key runs a deliberately CPU-expensive KDF
    // (bcrypt_pbkdf) for a passphrase-protected key plus a synchronous file
    // read, so it runs on `spawn_blocking` rather than stalling this async
    // connect path (and unrelated sessions sharing the runtime).
    let path = path.to_string();
    let passphrase = Zeroizing::new(passphrase.clone());
    let key = tokio::task::spawn_blocking(move || load_secret_key(&path, passphrase.as_deref()))
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
        .map_err(|e| AppError::SshAuth(format!("publickey authentication error: {e}")))
}

/// Find the user-selected identity in the local agent by its (public)
/// fingerprint and delegate signing to the agent. The agent — possibly a
/// hardware token — owns the key; no key material passes through this
/// process. A hostile/spoofed agent cannot succeed: it would have to produce
/// a signature the server accepts without the private key.
async fn authenticate_with_agent(
    handle: &mut client::Handle<SshHandler>,
    username: &str,
    fingerprint: &str,
) -> Result<AuthResult, AppError> {
    let mut agent = crate::agent_ident::connect_agent_for_auth().await?;
    let public =
        crate::agent_ident::find_public_key(&agent.identities, fingerprint).ok_or_else(|| {
            AppError::SshAuth(
                "the SSH agent does not hold the selected identity — is the token \
                 plugged in and unlocked?"
                    .to_string(),
            )
        })?;
    // RSA agent keys need an explicit signature-hash negotiation; other key
    // types (ed25519, ecdsa, sk-*) ignore it.
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
        .map_err(|e| AppError::SshAuth(format!("agent authentication error: {e}")))
}

impl KbdTransport for client::Handle<SshHandler> {
    async fn start(&mut self, username: &str) -> Result<KeyboardInteractiveAuthResponse, AppError> {
        self.authenticate_keyboard_interactive_start(username, None)
            .await
            .map_err(keyboard_interactive_error)
    }

    async fn respond(
        &mut self,
        answers: Vec<String>,
    ) -> Result<KeyboardInteractiveAuthResponse, AppError> {
        self.authenticate_keyboard_interactive_respond(answers)
            .await
            .map_err(keyboard_interactive_error)
    }
}

fn keyboard_interactive_error(err: russh::Error) -> AppError {
    AppError::SshAuth(format!("keyboard-interactive authentication error: {err}"))
}

/// Run [`establish`] within `deadline`, which covers the ENTIRE
/// handshake+auth flow — not just the TCP connect `establish` already bounds
/// internally (B3) — minus the time the user spends on a prompt. A host that
/// accepts TCP but never speaks SSH, or stalls mid-auth, is always bounded.
async fn establish_with_deadline(
    host: &str,
    port: u16,
    username: &str,
    creds: &AuthCredentials,
    handler: SshHandler,
    connect_timeout: Duration,
    deadline: &ConnectDeadline,
) -> Result<client::Handle<SshHandler>, AppError> {
    let work = establish(host, port, username, creds, handler, connect_timeout);
    within_deadline(deadline, work).await.unwrap_or_else(|| {
        Err(AppError::SshConnect(format!(
            "connecting to {host}:{port} timed out during the SSH handshake or authentication"
        )))
    })
}

/// `None` once `deadline` ran out before `work` finished.
async fn within_deadline<T>(
    deadline: &ConnectDeadline,
    work: impl Future<Output = T>,
) -> Option<T> {
    tokio::select! {
        result = work => Some(result),
        _ = deadline.expired() => None,
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
/// the target handle and the jump connection, to [`close_jump`] once the
/// target is done (closing it ends the channel the target rides on). Only the
/// TCP connect to the jump host is bounded here (by `connect_timeout`); the
/// caller wraps this whole function in the single overall deadline (see
/// `establish_target`), which is what bounds the channel-open and the target
/// handshake too.
async fn connect_through_jump(
    target: &Endpoint<'_>,
    target_handler: SshHandler,
    jump: &JumpHop,
    connect_timeout: Duration,
) -> Result<(client::Handle<SshHandler>, JumpConnection), AppError> {
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

    let (stream, target_done) = read_ahead(channel.into_stream());
    let target_handle =
        establish_over_stream(stream, target.username, target.creds, target_handler).await?;

    let jump = JumpConnection {
        handle: jump_handle,
        target_done,
    };
    Ok((target_handle, jump))
}

/// A jump host's connection, which must outlive the target riding it.
pub(crate) struct JumpConnection {
    handle: client::Handle<SshHandler>,
    /// Closed once the target's last bytes went out on the jump channel.
    target_done: watch::Receiver<()>,
}

/// The jump channel as the target connection's stream, read ahead into an
/// unbounded backlog. The target connection's loop stops reading while a
/// write waits on the jump channel's window; the jump connection would then
/// block handing it more data, in front of the window adjust that write is
/// waiting for. Any cap brings that back: the target's channels each leave up
/// to a window unread.
/// The returned receiver is closed once the bridge ended.
fn read_ahead<S>(channel: S) -> (DuplexStream, watch::Receiver<()>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (target_side, channel_side) = tokio::io::duplex(64 * 1024);
    let (done, target_done) = watch::channel(());
    tokio::spawn(async move {
        let _ = bridge_until_either_ends(channel_side, channel, Pace::UNLIMITED).await;
        drop(done);
    });
    (target_side, target_done)
}

/// Establish a connection to `target`, either directly or through a single
/// jump host (`ProxyJump`) — the one connect path shells, tunnels and SFTP
/// share. Returns the authenticated target handle plus, for a jumped
/// connection, the jump connection — which the caller [`close_jump`]s only
/// once done with the target, since closing it ends the direct-tcpip channel
/// the target rides on.
pub(crate) async fn establish_target(
    target: Endpoint<'_>,
    jump: Option<&JumpHop>,
    target_handler: SshHandler,
    connect_timeout: Duration,
    overall_timeout: Duration,
) -> Result<(client::Handle<SshHandler>, Option<JumpConnection>), AppError> {
    let deadline = ConnectDeadline::new(overall_timeout);
    let target_handler = target_handler.with_deadline(Arc::clone(&deadline));
    let Some(jump) = jump else {
        let handle = establish_with_deadline(
            target.host,
            target.port,
            target.username,
            target.creds,
            target_handler,
            connect_timeout,
            &deadline,
        )
        .await?;
        return Ok((handle, None));
    };
    // A SINGLE overall deadline covers the whole two-hop establish — both
    // handshakes AND the channel-open between them — so a jumped connect can
    // never exceed the same budget a direct one gets, and a jump host that
    // accepts but black-holes the channel-open to an unreachable target can't
    // hang the connection in "Connecting".
    let work = connect_through_jump(&target, target_handler, jump, connect_timeout);
    match within_deadline(&deadline, work).await {
        Some(Ok((target_handle, jump_handle))) => Ok((target_handle, Some(jump_handle))),
        Some(Err(e)) => Err(e),
        None => Err(AppError::SshConnect(format!(
            "connecting to {}:{} through jump host {}:{} timed out",
            target.host, target.port, jump.host, jump.port
        ))),
    }
}

/// Close the jump host's connection (if any) once the target riding on it has
/// been disconnected, after letting the target's disconnect through (within
/// `TARGET_CLOSE_GRACE`). Best-effort, like every other teardown.
pub(crate) async fn close_jump(jump: Option<&JumpConnection>) {
    let Some(jump) = jump else {
        return;
    };
    let mut target_done = jump.target_done.clone();
    let _ = timeout(TARGET_CLOSE_GRACE, target_done.changed()).await;
    let _ = jump
        .handle
        .disconnect(russh::Disconnect::ByApplication, "", "")
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_overall_deadline_adds_up_connect_prompt_and_handshake() {
        let second = Duration::from_secs(1);
        let overall = overall_establish_timeout(second, 10 * second, 100 * second);
        assert_eq!(overall, 111 * second);
    }

    #[tokio::test]
    async fn read_ahead_takes_any_amount_while_the_target_is_not_reading() {
        use tokio::io::AsyncWriteExt;
        let (channel, mut jump_side) = tokio::io::duplex(64 * 1024);
        let (_target_side, _target_done) = read_ahead(channel);

        // Each of the target's channels may leave a window unread: any cap
        // would be reached by enough of them.
        let flood = vec![7u8; 4 * Pace::DEFAULT.backlog];
        let taken =
            tokio::time::timeout(Duration::from_secs(10), jump_side.write_all(&flood)).await;
        assert!(taken.is_ok(), "the jump channel must never stop being read");
    }

    #[tokio::test]
    async fn read_ahead_reports_done_once_the_target_side_ended() {
        let (channel, _jump_side) = tokio::io::duplex(64);
        let (target_side, mut target_done) = read_ahead(channel);

        drop(target_side);

        let ended = tokio::time::timeout(Duration::from_secs(5), target_done.changed()).await;
        assert!(ended.is_ok(), "the bridge must end with the target");
    }

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
