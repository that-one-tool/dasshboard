//! SSH session core (SPEC.md §3/§6): `SessionManager` owns a
//! `HashMap<SessionId, SessionHandle>`, one `tokio` task per live session, and
//! the host-key trust machinery.
//!
//! **This module is deliberately Tauri-free.** All frontend-facing effects
//! (streaming terminal bytes, `session_status` events, `host_key_prompt`
//! events) go through the [`SessionSink`] trait, whose production implementor
//! lives in `commands.rs` (wrapping a Tauri `AppHandle` + IPC `Channel`) and
//! whose test implementor collects into channels. That split lets the whole
//! SSH stack — connect, auth, PTY/shell, host-key TOFU, cleanup — run in
//! `cargo test` against an in-process russh server with no Tauri app and no
//! Docker (SPEC.md §9).
//!
//! ## Locking & anti-deadlock design (the reviewer's focus)
//!
//! - The session map is a plain `std::sync::Mutex<HashMap<..>>`. It is only
//!   ever locked to insert/remove/clone-out an mpsc `Sender`; the guard is
//!   **never held across an `.await`** (every command clones the `Sender` out
//!   under the lock, drops the guard, then awaits the send).
//! - The host-key prompt (inside russh's `check_server_key`, which runs on the
//!   session task) registers a `oneshot` receiver in the [`PromptRegistry`],
//!   drops the registry lock, emits the event, then awaits the receiver with a
//!   timeout. No lock is held while awaiting the user. A RAII [`PromptGuard`]
//!   removes the registry entry on every exit path (user reply, timeout, or
//!   the task being dropped mid-prompt), so nothing leaks and a torn-down
//!   session's pending prompt simply resolves to "reject" (dropped sender).
//! - Each session task removes its own map entry when it exits, for *every*
//!   terminal reason (auth failure, mid-handshake disconnect, channel close,
//!   error). Cleanup has a single owner.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client;
use russh::keys::ssh_key::{HashAlg, PublicKey};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, Pty};
use serde::Serialize;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{timeout, MissedTickBehavior};
use uuid::Uuid;

use crate::error::AppError;
use crate::known_hosts::{KnownHost, KnownHostsStore, Verdict};

/// Default connect (TCP + handshake reachability) timeout — SPEC.md §6.
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Default host-key trust-prompt timeout — SPEC.md §6 (reject on elapse).
pub const DEFAULT_PROMPT_TIMEOUT: Duration = Duration::from_secs(60);
/// Default slack budgeted for the SSH version exchange/KEX and the
/// authentication exchange, on top of whatever `DEFAULT_CONNECT_TIMEOUT` and
/// `DEFAULT_PROMPT_TIMEOUT` already cover (B3). Together they form the
/// overall `establish` deadline — see `SessionManager::overall_establish_timeout`.
pub const DEFAULT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
/// Keepalive cadence — SPEC.md §6.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
/// PTY terminal type requested from the server — SPEC.md §6.
const TERM: &str = "xterm-256color";
/// PTY terminal modes sent with the `pty-req`. `IUTF8` (RFC-8160, opcode 42)
/// tells the server's line discipline the terminal is UTF-8, so cooked-mode
/// erase (backspace/word-kill) deletes a whole multibyte character instead of a
/// single byte — otherwise a dangling partial sequence renders as `�` in the
/// terminal. `1` = enabled.
const PTY_MODES: &[(Pty, u32)] = &[(Pty::IUTF8, 1)];
/// UTF-8 locale forwarded to the remote so programs emit UTF-8 output (e.g.
/// `ls` of accented filenames, `man`, ncurses box-drawing) instead of legacy
/// 8-bit bytes that render as `�`. Sent as `LANG` + `LC_CTYPE`; `LC_CTYPE`
/// is the piece that governs character encoding. `C.UTF-8` is used because
/// glibc guarantees it without installed locale data — unlike `en_US.UTF-8`,
/// which is absent on many minimal images and would fall back to non-UTF-8.
/// Best-effort: a server whose `AcceptEnv` doesn't allow these silently drops
/// them (we send `want_reply = false`), which is why `IUTF8` above is the
/// primary fix and this is the complement for program *output*.
const LOCALE_ENV: &[(&str, &str)] = &[("LANG", "C.UTF-8"), ("LC_CTYPE", "C.UTF-8")];
/// Bound on the per-session control channel. Backpressure here means the UI is
/// producing keystrokes faster than the SSH task drains them, which never
/// realistically happens; the bound just keeps the channel from being
/// unbounded (a standing review concern).
const CONTROL_CHANNEL_CAPACITY: usize = 256;

/// Lifecycle status mirrored to the frontend `session_status` event
/// (SPEC.md §5). Serializes to the exact lowercase strings in the spec.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionStatus {
    Connecting,
    Connected,
    Disconnected,
    Error,
}

impl SessionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionStatus::Connecting => "connecting",
            SessionStatus::Connected => "connected",
            SessionStatus::Disconnected => "disconnected",
            SessionStatus::Error => "error",
        }
    }
}

/// Payload of the `host_key_prompt` event (SPEC.md §5). `camelCase` on the
/// wire. Carries no secret material.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyPromptPayload {
    pub prompt_id: String,
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub changed: bool,
}

/// The credential a device authenticates with. Constructed in `commands.rs`
/// from the device's auth method + the keyring secret; the secret never
/// appears in any event, log, or error message.
#[derive(Clone)]
pub enum AuthCredentials {
    Password(String),
    Key {
        path: String,
        passphrase: Option<String>,
    },
}

/// Hand-rolled `Debug` that redacts the password/passphrase. The derived impl
/// would print the raw secret, which is reachable from test-only `panic!`
/// messages (`build_credentials_*` assertions) — this keeps the codebase's
/// "the secret never leaves this type in the clear" invariant true even in
/// test output on an assertion failure.
impl std::fmt::Debug for AuthCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthCredentials::Password(_) => f.write_str("Password(<redacted>)"),
            AuthCredentials::Key { path, .. } => f
                .debug_struct("Key")
                .field("path", path)
                .field("passphrase", &"<redacted>")
                .finish(),
        }
    }
}

/// Sink for everything the SSH core needs to surface to the frontend. The
/// production impl emits Tauri events / streams over the IPC channel; the test
/// impl records into channels. Kept object-safe (`Arc<dyn SessionSink>`).
pub trait SessionSink: Send + Sync {
    /// Verbatim server output bytes → per-session IPC channel (SPEC.md §3).
    fn on_data(&self, bytes: &[u8]);
    /// A lifecycle change → `session_status` event.
    fn on_status(&self, status: SessionStatus, message: Option<String>);
    /// An unknown/changed host key needs the user's decision →
    /// `host_key_prompt` event.
    fn on_host_key_prompt(&self, payload: HostKeyPromptPayload);
}

/// The connection-shaped parameters for a session (as opposed to bookkeeping
/// like `session_id`/`sink`), bundled so `spawn_session`/`run_session` don't
/// need six-plus positional parameters of their own (B8). Constructed by the
/// `connect` command in `commands.rs`, hence `pub(crate)`.
pub(crate) struct ConnectParams {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) creds: AuthCredentials,
    pub(crate) cols: u32,
    pub(crate) rows: u32,
}

/// Control messages sent to a session task via its mpsc handle.
enum SessionControl {
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Disconnect,
}

/// The manager's per-session handle: just the control `Sender`. Dropping every
/// clone of it (i.e. the manager forgetting the session) makes the task's
/// `control_rx.recv()` return `None`, which the task treats as a disconnect.
struct SessionHandle {
    control: mpsc::Sender<SessionControl>,
}

/// Registry of in-flight host-key prompts: `promptId -> oneshot::Sender`.
/// Shared (via `Arc`) between the session tasks (which register + await) and
/// the `respond_host_key` command (which resolves).
#[derive(Default)]
pub struct PromptRegistry {
    pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
}

/// RAII cleanup for a registered prompt. Removing on drop guarantees the
/// registry entry never outlives the awaiting task, no matter how that task
/// ends (reply, timeout, or being dropped mid-prompt when the session is torn
/// down). Removing an already-resolved entry is a harmless no-op.
struct PromptGuard {
    registry: Arc<PromptRegistry>,
    prompt_id: String,
}

impl Drop for PromptGuard {
    fn drop(&mut self) {
        self.registry.remove(&self.prompt_id);
    }
}

impl PromptRegistry {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, oneshot::Sender<bool>>> {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Register a prompt, returning the receiver to await and a guard that
    /// cleans up the entry on drop. Locks only to insert; never across await.
    fn register(self: &Arc<Self>, prompt_id: String) -> (oneshot::Receiver<bool>, PromptGuard) {
        let (tx, rx) = oneshot::channel();
        self.lock().insert(prompt_id.clone(), tx);
        let guard = PromptGuard {
            registry: Arc::clone(self),
            prompt_id,
        };
        (rx, guard)
    }

    /// Resolve a pending prompt. Returns `true` if a prompt with that id was
    /// waiting (so the command can distinguish a stale/duplicate response).
    pub fn respond(&self, prompt_id: &str, accept: bool) -> bool {
        let sender = self.lock().remove(prompt_id);
        match sender {
            Some(tx) => {
                // Err only if the awaiting task already went away — harmless.
                let _ = tx.send(accept);
                true
            }
            None => false,
        }
    }

    fn remove(&self, prompt_id: &str) {
        self.lock().remove(prompt_id);
    }
}

/// russh client handler. The only frontend-facing thing it does is drive the
/// host-key trust prompt; terminal I/O is handled via the `Channel` in the
/// session task, not the handler's data callbacks.
struct SshHandler {
    sink: Arc<dyn SessionSink>,
    known_hosts: Arc<KnownHostsStore>,
    prompts: Arc<PromptRegistry>,
    host: String,
    port: u16,
    prompt_timeout: Duration,
}

impl SshHandler {
    /// Emit the host-key prompt event and await the user's decision, bounded
    /// by `prompt_timeout`, holding no lock while waiting. The prompt is
    /// registered BEFORE the event is emitted, so a very fast user reply can
    /// never race ahead of the receiver existing. Returns `false` on timeout
    /// or a dropped sender (session torn down mid-prompt) — the registry
    /// entry is removed on every exit path via the `PromptGuard`.
    async fn await_host_key_decision(
        &self,
        key_type: &str,
        fingerprint: &str,
        changed: bool,
    ) -> bool {
        let prompt_id = Uuid::new_v4().to_string();
        let (rx, _guard) = self.prompts.register(prompt_id.clone());

        self.sink.on_host_key_prompt(HostKeyPromptPayload {
            prompt_id,
            host: self.host.clone(),
            port: self.port,
            key_type: key_type.to_string(),
            fingerprint: fingerprint.to_string(),
            changed,
        });

        match timeout(self.prompt_timeout, rx).await {
            Ok(Ok(accept)) => accept,
            Ok(Err(_)) => false, // sender dropped => treat as reject
            Err(_) => false,     // timed out => reject (SPEC §6)
        }
    }

    /// Persist an accepted host key (TOFU) / overwrite on accepted change.
    /// The write is a blocking `create_dir_all`+`write`+`rename` syscall
    /// sequence, so it runs on `spawn_blocking` rather than directly on this
    /// async handler task (which is driving the SSH transport). A persistence
    /// failure is non-fatal (the user is simply re-prompted next time) and is
    /// only logged — the message never contains secret material.
    async fn persist_trusted_key(&self, key_type: String, fingerprint: String) {
        let known_hosts = Arc::clone(&self.known_hosts);
        let host = self.host.clone();
        let port = self.port;
        let entry = KnownHost {
            key_type,
            fingerprint,
        };
        match tokio::task::spawn_blocking(move || known_hosts.trust(&host, port, entry)).await {
            Ok(Ok(())) => {}
            Ok(Err(err)) => eprintln!("[DaSSHboard] failed to persist trusted host key: {err}"),
            Err(join_err) => eprintln!("[DaSSHboard] host-key persist task failed: {join_err}"),
        }
    }
}

impl client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let key_type = server_public_key.algorithm().to_string();

        let changed = match self
            .known_hosts
            .verdict(&self.host, self.port, &fingerprint)
        {
            Verdict::Known => return Ok(true),
            Verdict::Unknown => false,
            Verdict::Changed => true,
        };

        let accepted = self
            .await_host_key_decision(&key_type, &fingerprint, changed)
            .await;

        if accepted {
            self.persist_trusted_key(key_type, fingerprint).await;
        }

        // Ok(false) makes russh abort the handshake with `Error::UnknownKey`,
        // which `establish` maps to `HostKeyRejected`.
        Ok(accepted)
    }
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
    let config = Arc::new(client::Config {
        // We drive keepalive explicitly in the session loop; no inactivity GC.
        inactivity_timeout: None,
        ..Default::default()
    });

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
            let passphrase = passphrase.clone();
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

/// Open a session channel, request a PTY + shell, then pump bytes both ways
/// and send keepalives until the channel closes or a disconnect is requested.
async fn run_shell(
    handle: client::Handle<SshHandler>,
    sink: Arc<dyn SessionSink>,
    mut control_rx: mpsc::Receiver<SessionControl>,
    cols: u32,
    rows: u32,
) -> Result<(), AppError> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::SshChannel(format!("could not open session channel: {e}")))?;

    channel
        .request_pty(false, TERM, cols, rows, 0, 0, PTY_MODES)
        .await
        .map_err(|e| AppError::SshChannel(format!("PTY request failed: {e}")))?;

    // Best-effort locale hint (see `LOCALE_ENV`). `want_reply = false` so a
    // server that rejects the vars via `AcceptEnv` doesn't fail the session.
    for (name, value) in LOCALE_ENV {
        let _ = channel.set_env(false, *name, *value).await;
    }

    channel
        .request_shell(true)
        .await
        .map_err(|e| AppError::SshChannel(format!("shell request failed: {e}")))?;

    let mut keepalive = tokio::time::interval(KEEPALIVE_INTERVAL);
    keepalive.set_missed_tick_behavior(MissedTickBehavior::Delay);
    keepalive.tick().await; // consume the immediate first tick

    loop {
        let keep_running = tokio::select! {
            msg = channel.wait() => handle_channel_msg(msg, &sink),
            ctrl = control_rx.recv() => handle_control(ctrl, &mut channel).await,
            _ = keepalive.tick() => handle_keepalive(&handle).await,
        };
        if !keep_running {
            break;
        }
    }

    Ok(())
}

/// Route one message off the server channel: stream data to the sink, or
/// signal the pump loop to stop on EOF/close/transport-end. Returns whether
/// the loop should keep running.
fn handle_channel_msg(msg: Option<ChannelMsg>, sink: &Arc<dyn SessionSink>) -> bool {
    match msg {
        Some(ChannelMsg::Data { ref data }) => {
            sink.on_data(data);
            true
        }
        Some(ChannelMsg::ExtendedData { ref data, .. }) => {
            sink.on_data(data);
            true
        }
        // Remote closed the channel (shell exited) or the transport ended:
        // clean disconnect.
        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => false,
        // Ignore the exit status itself; the following Close ends us.
        _ => true,
    }
}

/// Apply one control message (keystrokes, resize, or disconnect) to the
/// channel. Returns whether the pump loop should keep running.
async fn handle_control(
    ctrl: Option<SessionControl>,
    channel: &mut russh::Channel<client::Msg>,
) -> bool {
    match ctrl {
        Some(SessionControl::Write(bytes)) => channel.data(&bytes[..]).await.is_ok(),
        Some(SessionControl::Resize { cols, rows }) => {
            // A failed window-change isn't fatal to the session.
            let _ = channel.window_change(cols, rows, 0, 0).await;
            true
        }
        // Explicit disconnect, or the manager dropped the handle.
        Some(SessionControl::Disconnect) | None => {
            let _ = channel.eof().await;
            let _ = channel.close().await;
            false
        }
    }
}

/// Send one keepalive ping. Returns whether the pump loop should keep running
/// (a failed keepalive means the transport is gone).
async fn handle_keepalive(handle: &client::Handle<SshHandler>) -> bool {
    handle.send_keepalive(false).await.is_ok()
}

/// Drain control messages until a disconnect (or the manager drops the
/// handle), ignoring any keystrokes/resizes queued before the shell exists.
/// Used to race the handshake so a disconnect requested mid-handshake (even
/// while a host-key prompt is pending) tears the task down promptly.
async fn wait_for_disconnect(rx: &mut mpsc::Receiver<SessionControl>) {
    loop {
        match rx.recv().await {
            Some(SessionControl::Disconnect) | None => return,
            _ => continue,
        }
    }
}

/// The full lifecycle of one session task: connect+auth (racing an early
/// disconnect), then shell. Returns `Ok(())` for any clean end and `Err` for a
/// failure that should surface as `session_status: error`. `overall_timeout`
/// is the B3 backstop covering the whole handshake+auth flow — see
/// `establish_with_deadline`.
async fn run_session(
    params: ConnectParams,
    handler: SshHandler,
    connect_timeout: Duration,
    overall_timeout: Duration,
    sink: Arc<dyn SessionSink>,
    mut control_rx: mpsc::Receiver<SessionControl>,
) -> Result<(), AppError> {
    let handle = tokio::select! {
        biased;
        // If a disconnect arrives during the handshake, abort: dropping the
        // `establish` future drops the handler (and any PromptGuard within),
        // so a pending host-key prompt is cleaned up too.
        _ = wait_for_disconnect(&mut control_rx) => return Ok(()),
        result = establish_with_deadline(
            &params.host,
            params.port,
            &params.username,
            &params.creds,
            handler,
            connect_timeout,
            overall_timeout,
        ) => result?,
    };

    sink.on_status(SessionStatus::Connected, None);
    run_shell(handle, sink, control_rx, params.cols, params.rows).await
}

/// Owns all live sessions and the host-key machinery. Lives in Tauri managed
/// state behind an `Arc` (see `AppState`).
pub struct SessionManager {
    sessions: Mutex<HashMap<String, SessionHandle>>,
    prompts: Arc<PromptRegistry>,
    known_hosts: Arc<KnownHostsStore>,
    connect_timeout: Duration,
    prompt_timeout: Duration,
    handshake_timeout: Duration,
}

impl SessionManager {
    pub fn new(
        known_hosts: Arc<KnownHostsStore>,
        connect_timeout: Duration,
        prompt_timeout: Duration,
        handshake_timeout: Duration,
    ) -> Self {
        SessionManager {
            sessions: Mutex::new(HashMap::new()),
            prompts: Arc::new(PromptRegistry::default()),
            known_hosts,
            connect_timeout,
            prompt_timeout,
            handshake_timeout,
        }
    }

    /// Production constructor with the SPEC §6 timeouts (10 s connect,
    /// 60 s prompt, 30 s handshake/auth slack).
    pub fn with_defaults(known_hosts: Arc<KnownHostsStore>) -> Self {
        Self::new(
            known_hosts,
            DEFAULT_CONNECT_TIMEOUT,
            DEFAULT_PROMPT_TIMEOUT,
            DEFAULT_HANDSHAKE_TIMEOUT,
        )
    }

    /// The host-key TOFU store this manager consults and persists to, shared
    /// (behind an `Arc`) so the management commands (`list_known_hosts` /
    /// `forget_host`) can read and mutate the same trust store the live
    /// sessions use.
    pub fn known_hosts(&self) -> Arc<KnownHostsStore> {
        Arc::clone(&self.known_hosts)
    }

    /// Overall deadline for one `establish` call: TCP connect + SSH
    /// handshake + any host-key prompt wait + authentication (B3). Bounds a
    /// peer that accepts TCP but never speaks SSH, or stalls mid-auth, while
    /// staying generously above `prompt_timeout` alone so a connection
    /// legitimately waiting on the host-key prompt is never cut off early.
    fn overall_establish_timeout(&self) -> Duration {
        self.connect_timeout + self.prompt_timeout + self.handshake_timeout
    }

    /// Number of live sessions currently tracked. Used by the app-close handler
    /// (`lib.rs`) to decide whether a graceful `disconnect_all` is needed, by
    /// `disconnect_all` itself to poll teardown to completion, and by Phase 3's
    /// leak tests to assert cleanup.
    pub fn session_count(&self) -> usize {
        self.lock_sessions().len()
    }

    /// Whether this manager owns `session_id`. Lets the command layer route
    /// write/resize/disconnect to the right manager (SSH vs serial) by
    /// ownership. Locks only to check membership; never across an await.
    pub fn owns(&self, session_id: &str) -> bool {
        self.lock_sessions().contains_key(session_id)
    }

    fn lock_sessions(&self) -> std::sync::MutexGuard<'_, HashMap<String, SessionHandle>> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Clone out a session's control `Sender` (lock held only for the clone,
    /// never across the subsequent await).
    fn control_of(&self, session_id: &str) -> Option<mpsc::Sender<SessionControl>> {
        self.lock_sessions()
            .get(session_id)
            .map(|h| h.control.clone())
    }

    fn build_handler(&self, host: String, port: u16, sink: Arc<dyn SessionSink>) -> SshHandler {
        SshHandler {
            sink,
            known_hosts: Arc::clone(&self.known_hosts),
            prompts: Arc::clone(&self.prompts),
            host,
            port,
            prompt_timeout: self.prompt_timeout,
        }
    }

    /// Spawn a live shell session. Inserts the handle synchronously (so the map
    /// reflects the session the instant this returns) and drives the rest on a
    /// tokio task that removes its own entry on exit.
    ///
    pub fn spawn_session(
        self: &Arc<Self>,
        session_id: String,
        params: ConnectParams,
        sink: Arc<dyn SessionSink>,
    ) {
        let (control_tx, control_rx) = mpsc::channel(CONTROL_CHANNEL_CAPACITY);
        self.lock_sessions().insert(
            session_id.clone(),
            SessionHandle {
                control: control_tx,
            },
        );

        let handler = self.build_handler(params.host.clone(), params.port, Arc::clone(&sink));
        let manager = Arc::clone(self);
        let connect_timeout = self.connect_timeout;
        let overall_timeout = self.overall_establish_timeout();

        tokio::spawn(async move {
            sink.on_status(SessionStatus::Connecting, None);

            let result = run_session(
                params,
                handler,
                connect_timeout,
                overall_timeout,
                Arc::clone(&sink),
                control_rx,
            )
            .await;

            match result {
                Ok(()) => sink.on_status(SessionStatus::Disconnected, None),
                // AppError messages are always secret-free (see error.rs).
                Err(err) => sink.on_status(SessionStatus::Error, Some(err.to_string())),
            }

            // Single owner of cleanup: the task removes its own entry for every
            // terminal reason (success, auth fail, mid-handshake drop, error).
            manager.lock_sessions().remove(&session_id);
        });
    }

    /// Send keystrokes to a session. Unknown/closed session ⇒ silently ignored.
    pub async fn write_stdin(&self, session_id: &str, data: Vec<u8>) {
        if let Some(control) = self.control_of(session_id) {
            let _ = control.send(SessionControl::Write(data)).await;
        }
    }

    /// Resize a session's PTY. Unknown/closed session ⇒ ignored.
    pub async fn resize_pty(&self, session_id: &str, cols: u32, rows: u32) {
        if let Some(control) = self.control_of(session_id) {
            let _ = control.send(SessionControl::Resize { cols, rows }).await;
        }
    }

    /// Request a graceful disconnect. Idempotent: an unknown `session_id` is a
    /// no-op (SPEC §5). The task performs the actual map removal when it exits.
    pub async fn disconnect(&self, session_id: &str) {
        if let Some(control) = self.control_of(session_id) {
            let _ = control.send(SessionControl::Disconnect).await;
        }
    }

    /// Gracefully disconnect *every* live session and wait (briefly) for their
    /// tasks to tear down, so closing the app closes SSH cleanly rather than
    /// dropping the TCP sockets on process exit (SPEC §7 "App close"). Bounded by
    /// a short timeout so a stuck session can never block the window from closing.
    pub async fn disconnect_all(&self) {
        let ids: Vec<String> = self.lock_sessions().keys().cloned().collect();
        for id in &ids {
            self.disconnect(id).await;
        }
        // Each task removes its own map entry on exit; wait up to ~1s for that.
        for _ in 0..50 {
            if self.session_count() == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Resolve a pending host-key trust prompt (SPEC §5, `respond_host_key`).
    pub fn respond_host_key(&self, prompt_id: &str, accept: bool) {
        self.prompts.respond(prompt_id, accept);
    }

    /// Connect + authenticate + close, no shell (SPEC §5, `test_connection`).
    /// Uses the same host-key path as a real connect, so a first-contact test
    /// can raise a trust prompt just like a live session. Bounded by the same
    /// overall `establish` deadline as a live session (B3), so an
    /// unresponsive-but-TCP-accepting host can no longer hang this forever.
    pub async fn test_connection(
        &self,
        host: String,
        port: u16,
        username: String,
        creds: AuthCredentials,
        sink: Arc<dyn SessionSink>,
    ) -> Result<(), AppError> {
        let handler = self.build_handler(host.clone(), port, sink);
        let handle = establish_with_deadline(
            &host,
            port,
            &username,
            &creds,
            handler,
            self.connect_timeout,
            self.overall_establish_timeout(),
        )
        .await?;
        // Best-effort clean close; the result of `test_connection` is the auth
        // outcome, not the teardown.
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "")
            .await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_status_serializes_to_spec_strings() {
        assert_eq!(SessionStatus::Connecting.as_str(), "connecting");
        assert_eq!(SessionStatus::Connected.as_str(), "connected");
        assert_eq!(SessionStatus::Disconnected.as_str(), "disconnected");
        assert_eq!(SessionStatus::Error.as_str(), "error");
    }

    #[test]
    fn host_key_prompt_payload_is_camel_case() {
        let payload = HostKeyPromptPayload {
            prompt_id: "p1".into(),
            host: "h".into(),
            port: 22,
            key_type: "ssh-ed25519".into(),
            fingerprint: "SHA256:abc".into(),
            changed: true,
        };
        let value = serde_json::to_value(&payload).unwrap();
        assert_eq!(value["promptId"], "p1");
        assert_eq!(value["keyType"], "ssh-ed25519");
        assert_eq!(value["fingerprint"], "SHA256:abc");
        assert_eq!(value["changed"], true);
    }

    #[test]
    fn prompt_registry_respond_resolves_receiver() {
        let registry = Arc::new(PromptRegistry::default());
        let (rx, _guard) = registry.register("p1".into());
        assert!(registry.respond("p1", true));
        assert_eq!(rx.blocking_recv().ok(), Some(true));
        // A second response finds nothing pending.
        assert!(!registry.respond("p1", true));
    }

    #[test]
    fn prompt_guard_removes_entry_on_drop() {
        let registry = Arc::new(PromptRegistry::default());
        {
            let (_rx, _guard) = registry.register("p1".into());
            assert_eq!(registry.lock().len(), 1);
        }
        assert_eq!(registry.lock().len(), 0, "guard must clean up on drop");
    }

    #[test]
    fn respond_to_unknown_prompt_is_false() {
        let registry = Arc::new(PromptRegistry::default());
        assert!(!registry.respond("nope", true));
    }
}
