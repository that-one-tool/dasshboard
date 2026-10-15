//! SSH shell sessions (SPEC.md §3/§6): `SessionManager` owns a
//! `HashMap<SessionId, SessionHandle>` and one `tokio` task per live session;
//! connecting and host-key trust live in `crate::ssh`.
//!
//! **This module is deliberately Tauri-free.** All frontend-facing effects
//! (streaming terminal bytes, `session_status` events, `host_key_prompt`
//! events) go through the [`SessionSink`] trait, whose production implementor
//! lives in `commands/sessions.rs` (wrapping a Tauri `AppHandle` + IPC `Channel`) and
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
//!   session task) registers a `oneshot` receiver in the `PromptRegistry`,
//!   drops the registry lock, emits the event, then awaits the receiver with a
//!   timeout. No lock is held while awaiting the user. A RAII `PromptGuard`
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
use russh::{ChannelMsg, ChannelReadHalf, ChannelWriteHalf, Pty};
use tokio::sync::{mpsc, watch};
use tokio::time::timeout;

use crate::error::AppError;
use crate::known_hosts::KnownHostsStore;
use crate::session_sink::{SessionSink, SessionStatus};
use crate::ssh::establish::{
    close_jump, establish_target, DEFAULT_CONNECT_TIMEOUT, DEFAULT_HANDSHAKE_TIMEOUT,
    DEFAULT_PROMPT_TIMEOUT,
};
use crate::ssh::handler::SshHandler;
use crate::ssh::params::{AuthCredentials, Endpoint, JumpHop, KeepaliveConfig};
use crate::ssh::prompts::PromptRegistry;

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
/// How long each goodbye at the end of a session (the channel close, then the
/// SSH disconnect of the target and of the jump host) may take before the
/// connection is just dropped: a stalled server must not hold up app quit.
const CLOSE_GRACE: Duration = Duration::from_millis(300);

/// The connection-shaped parameters for a session (as opposed to bookkeeping
/// like `session_id`/`sink`), bundled so `spawn_session`/`run_session` don't
/// need six-plus positional parameters of their own (B8). Constructed by the
/// `connect` command in `commands/sessions.rs`.
///
/// `pub` (not `pub(crate)`) only so the in-process integration tests in
/// `tests/` — a separate crate — can build one; `#[doc(hidden)]` keeps it out
/// of the public docs, as this lib is consumed only by the app's own binary.
#[doc(hidden)]
pub struct ConnectParams {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub creds: AuthCredentials,
    pub cols: u32,
    pub rows: u32,
    /// Optional jump host (`ProxyJump`): connect to this first, then reach
    /// `host:port` through a direct-tcpip channel over it. `None` ⇒ direct.
    pub jump: Option<JumpHop>,
    /// SSH keepalive resolved from user settings, applied to this connection
    /// (and, for a jumped connection, to the jump hop too).
    pub keepalive: KeepaliveConfig,
    /// Forward the local SSH agent (`ssh -A`) to the target: accept the server's
    /// agent-forwarding channels and relay them to this machine's agent. Applies
    /// to the target only, never the jump hop.
    pub forward_agent: bool,
    /// Optional commands to type into the shell once it is ready (SPEC connect
    /// snippet). Already the device's stored snippet text; the session normalizes
    /// its line endings and sends it as keystrokes. `None` ⇒ nothing is sent.
    pub connect_snippet: Option<String>,
}

impl ConnectParams {
    fn endpoint(&self) -> Endpoint<'_> {
        Endpoint {
            host: &self.host,
            port: self.port,
            username: &self.username,
            creds: &self.creds,
        }
    }
}

/// Control messages sent to a session task via its mpsc handle.
enum SessionControl {
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
}

/// The manager's per-session handle. Dropping every clone of `control` makes
/// the task's `control_rx.recv()` return `None`, which it treats as a
/// disconnect.
struct SessionHandle {
    control: mpsc::Sender<SessionControl>,
    /// Set by `disconnect`. Out of band, so a disconnect never waits behind
    /// queued writes that a stalled server isn't taking.
    stop: watch::Sender<bool>,
}

/// Open a session channel, request a PTY + shell, then pump bytes both ways
/// and send keepalives until the channel closes or a disconnect is requested.
async fn run_shell(
    handle: &client::Handle<SshHandler>,
    sink: Arc<dyn SessionSink>,
    control_rx: mpsc::Receiver<SessionControl>,
    mut stop: watch::Receiver<bool>,
    (cols, rows): (u32, u32),
    forward_agent: bool,
    connect_snippet: Option<String>,
) -> Result<SessionStatus, AppError> {
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::SshChannel(format!("could not open session channel: {e}")))?;

    channel
        .request_pty(false, TERM, cols, rows, 0, 0, PTY_MODES)
        .await
        .map_err(|e| AppError::SshChannel(format!("PTY request failed: {e}")))?;

    // Best-effort agent-forwarding request (`auth-agent-req@openssh.com`). Sent
    // with `want_reply = false` so a server that refuses forwarding silently
    // ignores it rather than failing the session; the handler then relays any
    // agent channels the server opens back to the local agent.
    if forward_agent {
        let _ = channel.agent_forward(false).await;
    }

    // Best-effort locale hint (see `LOCALE_ENV`). `want_reply = false` so a
    // server that rejects the vars via `AcceptEnv` doesn't fail the session.
    for (name, value) in LOCALE_ENV {
        let _ = channel.set_env(false, *name, *value).await;
    }

    channel
        .request_shell(true)
        .await
        .map_err(|e| AppError::SshChannel(format!("shell request failed: {e}")))?;

    // Connect snippet: type the device's saved commands into the fresh shell, as
    // if the user had. Best-effort — a write failure just means the first
    // keystrokes didn't land, not a reason to fail the whole session.
    if let Some(bytes) = crate::device::connect_snippet_bytes(connect_snippet.as_deref()) {
        let _ = channel.data(&bytes[..]).await;
    }

    // Keepalive is handled by russh from the `client::Config` (see
    // `KeepaliveConfig`): it pings an idle link and drops the connection after
    // `keepalive_max` unanswered pings, which surfaces here as the channel
    // closing — so the pump loop only needs the data and control arms.
    //
    // Writes run on their own task so server output keeps being read while a
    // write waits on russh (a full outbound window, or its small session
    // queue). Reading only between writes deadlocked under heavy output: russh's
    // session loop blocked handing us output we weren't reading, so it never
    // took the rest of our write, and the terminal froze.
    let (mut reader, writer) = channel.split();
    let writer = Arc::new(writer);
    let mut writes = tokio::spawn(pump_controls(control_rx, Arc::clone(&writer)));
    // Reported by the server just before it closes the channel (after EOF).
    let mut exit_code = None;
    let status = loop {
        let end = tokio::select! {
            msg = reader.wait() => handle_channel_msg(msg, &sink, &mut exit_code),
            ended = &mut writes => Some(ended.unwrap_or(SessionStatus::Disconnected)),
            _ = stop.wait_for(|requested| *requested) => Some(SessionStatus::Disconnected),
        };
        if let Some(status) = end {
            break status;
        }
    };
    // Also cancels a write stuck on a stalled server.
    writes.abort();
    if *stop.borrow() {
        close_channel(&writer, &mut reader).await;
    }
    Ok(status)
}

/// End the shell channel politely (EOF, close, then the server's close in
/// reply, so the disconnect that follows doesn't cut that reply off), within
/// `CLOSE_GRACE`.
async fn close_channel(writer: &ChannelWriteHalf<client::Msg>, reader: &mut ChannelReadHalf) {
    let _ = timeout(CLOSE_GRACE, async {
        let _ = writer.eof().await;
        let _ = writer.close().await;
        while !matches!(reader.wait().await, Some(ChannelMsg::Close) | None) {}
    })
    .await;
}

/// Send the target, then the jump host, an SSH disconnect, so neither sees a
/// dropped socket; each within `CLOSE_GRACE`.
async fn close_connection(
    handle: &client::Handle<SshHandler>,
    jump: Option<&client::Handle<SshHandler>>,
) {
    let goodbye = handle.disconnect(russh::Disconnect::ByApplication, "", "");
    let _ = timeout(CLOSE_GRACE, goodbye).await;
    let _ = timeout(CLOSE_GRACE, close_jump(jump)).await;
}

/// Apply control messages to the channel until one ends the session; returns
/// that final status.
async fn pump_controls(
    mut control_rx: mpsc::Receiver<SessionControl>,
    writer: Arc<ChannelWriteHalf<client::Msg>>,
) -> SessionStatus {
    loop {
        if let Some(status) = handle_control(control_rx.recv().await, &writer).await {
            return status;
        }
    }
}

/// Route one message off the server channel: stream data to the sink, note
/// the shell's exit code, or end the pump loop. Returns the session's final
/// status once it is over.
fn handle_channel_msg(
    msg: Option<ChannelMsg>,
    sink: &Arc<dyn SessionSink>,
    exit_code: &mut Option<u32>,
) -> Option<SessionStatus> {
    match msg {
        Some(ChannelMsg::Data { ref data }) | Some(ChannelMsg::ExtendedData { ref data, .. }) => {
            sink.on_data(data);
            None
        }
        Some(ChannelMsg::ExitStatus { exit_status }) => {
            *exit_code = Some(exit_status);
            None
        }
        // The server closed the channel: the shell ended. OpenSSH sends the exit
        // status after EOF, so only Close (not EOF) decides.
        Some(ChannelMsg::Close) => Some(SessionStatus::for_shell_exit(*exit_code)),
        // The transport ended under us: a lost connection.
        None => Some(SessionStatus::Disconnected),
        // EOF, an exit signal, etc.: wait for the Close.
        _ => None,
    }
}

/// Apply one control message (keystrokes or resize) to the channel. Returns
/// the session's final status once it is over.
async fn handle_control(
    ctrl: Option<SessionControl>,
    channel: &ChannelWriteHalf<client::Msg>,
) -> Option<SessionStatus> {
    match ctrl {
        Some(SessionControl::Write(bytes)) => match channel.data(&bytes[..]).await {
            Ok(()) => None,
            Err(_) => Some(SessionStatus::Disconnected),
        },
        Some(SessionControl::Resize { cols, rows }) => {
            // A failed window-change isn't fatal to the session.
            let _ = channel.window_change(cols, rows, 0, 0).await;
            None
        }
        // The manager dropped the handle.
        None => Some(SessionStatus::Disconnected),
    }
}

/// Wait for a disconnect (the stop flag, or the manager dropping the handle),
/// applying the resizes queued before it. Used to race the handshake so a
/// disconnect requested mid-handshake (even while a host-key prompt is
/// pending) tears the task down promptly.
async fn wait_for_stop(
    rx: &mut mpsc::Receiver<SessionControl>,
    stop: &mut watch::Receiver<bool>,
    size: &mut (u32, u32),
) {
    tokio::select! {
        biased;
        () = track_resizes(rx, size) => {}
        _ = stop.wait_for(|requested| *requested) => {}
    }
}

/// Keep `size`, the `(cols, rows)` the PTY will be requested with, up to date,
/// so a pane resized while connecting doesn't start its shell at a stale
/// width. Keystrokes queued before the shell exists are dropped.
async fn track_resizes(rx: &mut mpsc::Receiver<SessionControl>, size: &mut (u32, u32)) {
    while let Some(control) = rx.recv().await {
        if let SessionControl::Resize { cols, rows } = control {
            *size = (cols, rows);
        }
    }
}

/// The full lifecycle of one session task: connect+auth (racing an early
/// disconnect), then shell. Returns the final status for a clean end
/// (`Disconnected` or `Exited`) and `Err` for a failure that should surface as
/// `session_status: error`. `overall_timeout`
/// is the B3 backstop covering the whole handshake+auth flow — see
/// `establish_target`.
async fn run_session(
    params: ConnectParams,
    mut handler: SshHandler,
    connect_timeout: Duration,
    overall_timeout: Duration,
    sink: Arc<dyn SessionSink>,
    mut control_rx: mpsc::Receiver<SessionControl>,
    mut stop: watch::Receiver<bool>,
) -> Result<SessionStatus, AppError> {
    // Abandons a pending host-key prompt if this returns mid-handshake.
    let _owner = handler.take_owner_token();
    let mut pty_size = (params.cols, params.rows);
    let (handle, jump) = tokio::select! {
        biased;
        // If a disconnect arrives during the handshake, abort: dropping the
        // `establish_target` future drops the handler(s) (and any PromptGuard
        // within) plus any jump handle, so a pending host-key prompt and the
        // jump connection are cleaned up too.
        _ = wait_for_stop(&mut control_rx, &mut stop, &mut pty_size) => return Ok(SessionStatus::Disconnected),
        result = establish_target(
            params.endpoint(),
            params.jump.as_ref(),
            handler,
            connect_timeout,
            overall_timeout,
        ) => result?,
    };

    sink.on_status(SessionStatus::Connected, None);
    // `jump` (the jump host's handle, for a jumped connection) must outlive
    // the shell: dropping it would tear down the direct-tcpip channel this
    // session rides on.
    let status = run_shell(
        &handle,
        sink,
        control_rx,
        stop,
        pty_size,
        params.forward_agent,
        params.connect_snippet,
    )
    .await;
    close_connection(&handle, jump.as_ref()).await;
    status
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

    fn build_handler(
        &self,
        host: String,
        port: u16,
        sink: Arc<dyn SessionSink>,
        keepalive: KeepaliveConfig,
        forward_agent: bool,
    ) -> SshHandler {
        SshHandler::new(
            sink,
            Arc::clone(&self.known_hosts),
            Arc::clone(&self.prompts),
            host,
            port,
            self.prompt_timeout,
            keepalive,
            forward_agent,
        )
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
        let (stop_tx, stop_rx) = watch::channel(false);
        self.lock_sessions().insert(
            session_id.clone(),
            SessionHandle {
                control: control_tx,
                stop: stop_tx,
            },
        );

        let handler = self.build_handler(
            params.host.clone(),
            params.port,
            Arc::clone(&sink),
            params.keepalive,
            params.forward_agent,
        );
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
                stop_rx,
            )
            .await;

            match result {
                Ok(status) => sink.on_status(status, None),
                // AppError messages are always secret-free (see error.rs).
                Err(err) => sink.on_error(&err),
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
        if let Some(handle) = self.lock_sessions().get(session_id) {
            handle.stop.send_replace(true);
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
    /// Goes through `jump` when the device has one, exactly like a connect.
    pub async fn test_connection(
        &self,
        host: String,
        port: u16,
        username: String,
        creds: AuthCredentials,
        jump: Option<JumpHop>,
        sink: Arc<dyn SessionSink>,
    ) -> Result<(), AppError> {
        let handler =
            self.build_handler(host.clone(), port, sink, KeepaliveConfig::disabled(), false);
        let target = Endpoint {
            host: &host,
            port,
            username: &username,
            creds: &creds,
        };
        let (handle, jump_handle) = establish_target(
            target,
            jump.as_ref(),
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
        close_jump(jump_handle.as_ref()).await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_resize_during_the_handshake_sets_the_pty_size() {
        let (tx, mut rx) = mpsc::channel(8);
        for control in [
            SessionControl::Resize {
                cols: 100,
                rows: 30,
            },
            SessionControl::Write(b"x".to_vec()),
            SessionControl::Resize {
                cols: 132,
                rows: 43,
            },
        ] {
            tx.send(control).await.unwrap();
        }
        let (stop_tx, mut stop_rx) = watch::channel(false);
        stop_tx.send_replace(true);
        let mut size = (80, 24);

        wait_for_stop(&mut rx, &mut stop_rx, &mut size).await;

        assert_eq!(size, (132, 43));
    }
}
