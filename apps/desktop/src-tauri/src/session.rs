//! SSH shell Sessions: `spawn_shell` runs one in the `SessionRegistry`,
//! which owns its id and lifecycle; connecting and host-key trust live in
//! `crate::ssh`.
//!
//! **This module is deliberately Tauri-free.** Frontend-facing effects go
//! through [`SessionSink`] and [`ConnectPrompter`], so the whole SSH stack runs
//! in `cargo test` against an in-process russh server (SPEC.md §9).
//!
//! No lock is held while a host-key or auth prompt awaits the user; a
//! disconnect mid-handshake drops the connect future, whose `PromptGuard`
//! abandons the pending prompt.

use std::future::Future;
use std::sync::Arc;

use russh::client;
use russh::{ChannelMsg, ChannelReadHalf, ChannelWriteHalf, Pty};
use tokio::sync::{mpsc, watch};
use tokio::time::timeout;

use crate::error::AppError;
use crate::session_registry::{NewSession, Resizes, RunnerControls, SessionRegistry};
use crate::session_sink::{SessionSink, SessionStatus};
use crate::ssh::close::CLOSE_GRACE;
use crate::ssh::connector::{SshConnection, SshConnector};
use crate::ssh::handler::SshHandler;
use crate::ssh::params::SshTarget;
use crate::ssh::prompts::ConnectPrompter;
use crate::x11::{warning_line, X11Forward, X11Local, X11Request};

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
/// The connection-shaped parameters for a session (as opposed to bookkeeping
/// like `session_id`/`sink`), bundled so `spawn_shell`/`run_session` don't
/// need six-plus positional parameters of their own (B8). Constructed by the
/// `connect` command in `commands/sessions.rs`.
///
/// `pub` (not `pub(crate)`) only so the in-process integration tests in
/// `tests/` — a separate crate — can build one; `#[doc(hidden)]` keeps it out
/// of the public docs, as this lib is consumed only by the app's own binary.
#[doc(hidden)]
pub struct ConnectParams {
    /// The server, its login, the optional jump host (`ProxyJump`) and the
    /// keepalive, which applies to the jump hop too.
    pub target: SshTarget,
    pub cols: u32,
    pub rows: u32,
    /// Forward the local SSH agent (`ssh -A`) to the target: accept the server's
    /// agent-forwarding channels and relay them to this machine's agent. Applies
    /// to the target only, never the jump hop.
    pub forward_agent: bool,
    /// Optional commands to type into the shell once it is ready (SPEC connect
    /// snippet). Already the device's stored snippet text; the session normalizes
    /// its line endings and sends it as keystrokes. `None` ⇒ nothing is sent.
    pub connect_snippet: Option<String>,
    /// Forward X11 to this local display (`ssh -X`/`-Y`). `None` ⇒ no X11;
    /// an error says why the display can't be used.
    pub x11: Option<Result<X11Local, String>>,
}

/// How `run_shell` sets up the session channel: the PTY's `(cols, rows)` and
/// the requests besides the PTY and shell.
struct ShellSetup {
    pty_size: (u32, u32),
    forward_agent: bool,
    x11: Option<X11Request>,
    connect_snippet: Option<String>,
}

/// Open a session channel, request a PTY + shell, then pump bytes both ways
/// and send keepalives until the channel closes or a disconnect is requested.
async fn run_shell(
    handle: &client::Handle<SshHandler>,
    sink: Arc<dyn SessionSink>,
    mut controls: RunnerControls,
    mut setup: ShellSetup,
) -> Result<SessionStatus, AppError> {
    // A pane resized while connecting starts its shell at its latest size.
    setup.pty_size = controls.resizes.latest().unwrap_or(setup.pty_size);
    let channel = open_shell(handle, &setup).await?;
    type_connect_snippet(&channel, &setup).await;
    Ok(pump_shell(channel, sink, controls).await)
}

/// Open a session channel and start a shell on a PTY, sending the forwarding
/// and locale requests first.
async fn open_shell(
    handle: &client::Handle<SshHandler>,
    setup: &ShellSetup,
) -> Result<russh::Channel<client::Msg>, AppError> {
    let (cols, rows) = setup.pty_size;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::SshChannel(format!("could not open session channel: {e}")))?;
    channel
        .request_pty(false, TERM, cols, rows, 0, 0, PTY_MODES)
        .await
        .map_err(|e| AppError::SshChannel(format!("PTY request failed: {e}")))?;
    request_forwarding(&channel, setup).await;
    send_locale(&channel).await;
    channel
        .request_shell(true)
        .await
        .map_err(|e| AppError::SshChannel(format!("shell request failed: {e}")))?;
    Ok(channel)
}

/// Best-effort locale hint (see `LOCALE_ENV`). `want_reply = false` so a
/// server that rejects the vars via `AcceptEnv` doesn't fail the session.
async fn send_locale(channel: &russh::Channel<client::Msg>) {
    for (name, value) in LOCALE_ENV {
        let _ = channel.set_env(false, *name, *value).await;
    }
}

/// Connect snippet: type the device's saved commands into the fresh shell, as
/// if the user had. Best-effort — a write failure just means the first
/// keystrokes didn't land, not a reason to fail the whole session.
async fn type_connect_snippet(channel: &russh::Channel<client::Msg>, setup: &ShellSetup) {
    if let Some(bytes) = crate::device::connect_snippet_bytes(setup.connect_snippet.as_deref()) {
        let _ = channel.data(&bytes[..]).await;
    }
}

/// Pump the shell until the channel closes, the writes end it, or a
/// disconnect is requested.
///
/// Keepalive is handled by russh from the `client::Config` (see
/// `KeepaliveConfig`): it pings an idle link and drops the connection after
/// `keepalive_max` unanswered pings, which surfaces here as the channel
/// closing — so the pump loop only needs the data and control arms.
///
/// Writes run on their own task so server output keeps being read while a
/// write waits on russh (a full outbound window, or its small session
/// queue). Reading only between writes deadlocked under heavy output: russh's
/// session loop blocked handing us output we weren't reading, so it never
/// took the rest of our write, and the terminal froze.
async fn pump_shell(
    channel: russh::Channel<client::Msg>,
    sink: Arc<dyn SessionSink>,
    RunnerControls {
        input,
        resizes,
        mut stop,
    }: RunnerControls,
) -> SessionStatus {
    let (mut reader, writer) = channel.split();
    let writer = Arc::new(writer);
    let mut writes = tokio::spawn(pump_controls(input, resizes, Arc::clone(&writer)));
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
    status
}

/// Best-effort agent (`auth-agent-req@openssh.com`) and X11 (`x11-req`)
/// forwarding requests. Sent with `want_reply = false` so a server that refuses
/// forwarding ignores them rather than failing the session; the handler then
/// relays the channels the server opens.
async fn request_forwarding(channel: &russh::Channel<client::Msg>, setup: &ShellSetup) {
    if setup.forward_agent {
        let _ = channel.agent_forward(false).await;
    }
    if let Some(x11) = &setup.x11 {
        let cookie = x11.cookie_hex.as_str();
        let _ = channel
            .request_x11(false, false, x11.protocol, cookie, x11.screen)
            .await;
    }
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

/// Apply writes and resizes to the channel until a write ends the session;
/// returns that final status.
async fn pump_controls(
    mut input: mpsc::Receiver<Vec<u8>>,
    mut resizes: Resizes,
    writer: Arc<ChannelWriteHalf<client::Msg>>,
) -> SessionStatus {
    loop {
        if let Some(status) = apply_next_control(&mut input, &mut resizes, &writer).await {
            return status;
        }
    }
}

/// Apply the next write or resize. Returns the session's final status once it
/// is over.
async fn apply_next_control(
    input: &mut mpsc::Receiver<Vec<u8>>,
    resizes: &mut Resizes,
    channel: &ChannelWriteHalf<client::Msg>,
) -> Option<SessionStatus> {
    tokio::select! {
        bytes = input.recv() => write_input(bytes, channel).await,
        (cols, rows) = resizes.next() => {
            // A failed window-change isn't fatal to the session.
            let _ = channel.window_change(cols, rows, 0, 0).await;
            None
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

/// Send keystrokes. Returns the session's final status once it is over.
async fn write_input(
    bytes: Option<Vec<u8>>,
    channel: &ChannelWriteHalf<client::Msg>,
) -> Option<SessionStatus> {
    let Some(bytes) = bytes else {
        // The registry dropped the handle.
        return Some(SessionStatus::Disconnected);
    };
    channel
        .data(&bytes[..])
        .await
        .err()
        .map(|_| SessionStatus::Disconnected)
}

/// Wait for a disconnect (the stop flag, or the registry dropping the handle).
/// Used to race the handshake so a disconnect requested mid-handshake (even
/// while a host-key prompt is pending) tears the task down promptly.
async fn wait_for_stop(input: &mut mpsc::Receiver<Vec<u8>>, stop: &mut watch::Receiver<bool>) {
    tokio::select! {
        biased;
        () = drop_input(input) => {}
        _ = stop.wait_for(|requested| *requested) => {}
    }
}

/// Keystrokes typed before the shell exists are dropped; returns once the
/// input closes.
async fn drop_input(input: &mut mpsc::Receiver<Vec<u8>>) {
    while input.recv().await.is_some() {}
}

/// The full lifecycle of one session task: connect+auth (racing an early
/// disconnect), then shell. Returns the final status for a clean end
/// (`Disconnected` or `Exited`) and `Err` for a failure that should surface as
/// `session_status: error`.
async fn run_session(
    mut params: ConnectParams,
    mut handler: SshHandler,
    ssh: &SshConnector,
    sink: Arc<dyn SessionSink>,
    mut controls: RunnerControls,
) -> Result<SessionStatus, AppError> {
    // Abandons a pending host-key prompt if this returns mid-handshake.
    let _owner = handler.take_owner_token();
    let setup = take_shell_setup(&mut params, handler.x11_request());
    let early_stop = wait_for_stop(&mut controls.input, &mut controls.stop);
    let Some(connection) = connect_or_stop(early_stop, &params, handler, ssh).await? else {
        return Ok(SessionStatus::Disconnected);
    };
    let status = serve_shell(connection.handle(), &params, sink, controls, setup).await;
    connection.close().await;
    status
}

/// The shell's setup, taking the connect snippet out of `params`.
fn take_shell_setup(params: &mut ConnectParams, x11: Option<X11Request>) -> ShellSetup {
    ShellSetup {
        pty_size: (params.cols, params.rows),
        forward_agent: params.forward_agent,
        x11,
        connect_snippet: params.connect_snippet.take(),
    }
}

/// Connect and authenticate; `None` when `early_stop` comes first.
async fn connect_or_stop(
    early_stop: impl Future<Output = ()>,
    params: &ConnectParams,
    handler: SshHandler,
    ssh: &SshConnector,
) -> Result<Option<SshConnection>, AppError> {
    tokio::select! {
        biased;
        // Dropping the connect future drops the handler(s) (and any
        // PromptGuard within) plus any jump handle, so a pending host-key
        // prompt and the jump connection are cleaned up too.
        () = early_stop => Ok(None),
        result = ssh.connect(params.target.endpoint(), params.target.jump.as_ref(), handler) => result.map(Some),
    }
}

/// Run the shell until it ends, logging why.
async fn serve_shell(
    handle: &client::Handle<SshHandler>,
    params: &ConnectParams,
    sink: Arc<dyn SessionSink>,
    controls: RunnerControls,
    setup: ShellSetup,
) -> Result<SessionStatus, AppError> {
    sink.on_status(SessionStatus::Connected, None);
    let stop_seen = controls.stop.clone();
    let status = run_shell(handle, sink, controls, setup).await;
    let label = format!("shell {}:{}", params.target.host, params.target.port);
    let end = shell_end(&status, *stop_seen.borrow());
    crate::app_log::info(format!("{label}: {end}"));
    status
}

/// Why a shell ended, for the log.
fn shell_end(status: &Result<SessionStatus, AppError>, by_user: bool) -> String {
    if by_user {
        return "closed by the user".to_string();
    }
    unrequested_shell_end(status)
}

fn unrequested_shell_end(status: &Result<SessionStatus, AppError>) -> String {
    match status {
        Ok(SessionStatus::Exited) => "the shell exited".to_string(),
        Ok(_) => "the shell's channel or connection ended".to_string(),
        Err(err) => format!("the shell failed: {err}"),
    }
}

/// X11 problems are written into the terminal, as `ssh` prints them there.
fn with_x11(
    handler: SshHandler,
    local: Option<Result<X11Local, String>>,
    sink: Arc<dyn SessionSink>,
) -> SshHandler {
    match local {
        None => handler,
        Some(Err(reason)) => {
            sink.on_data(warning_line(&reason).as_bytes());
            handler
        }
        Some(Ok(local)) => {
            let notice = Box::new(move |text: &str| sink.on_data(text.as_bytes()));
            handler.with_x11(Arc::new(X11Forward::new(local, notice)))
        }
    }
}

/// Start an SSH shell Session in `registry`, its connect raising prompts on
/// `prompter`.
pub fn spawn_shell(
    registry: &Arc<SessionRegistry>,
    ssh: &Arc<SshConnector>,
    session: NewSession,
    mut params: ConnectParams,
    prompter: Arc<dyn ConnectPrompter>,
) {
    let handler = shell_handler(ssh, &mut params, prompter, Arc::clone(&session.sink));
    let ssh = Arc::clone(ssh);
    registry.spawn(session, move |controls, sink| async move {
        run_session(params, handler, &ssh, sink, controls).await
    });
}

/// The shell's handler, taking the X11 display out of `params`.
fn shell_handler(
    ssh: &SshConnector,
    params: &mut ConnectParams,
    prompter: Arc<dyn ConnectPrompter>,
    sink: Arc<dyn SessionSink>,
) -> SshHandler {
    let target = &params.target;
    let handler = ssh
        .handler(target.host.clone(), target.port, target.keepalive, prompter)
        .with_agent_forwarding(params.forward_agent)
        .with_purpose("shell");
    with_x11(handler, params.x11.take(), sink)
}

/// Connect + authenticate + close, no shell (SPEC §5, `test_connection`).
/// Uses the same host-key path as a real connect, so a first-contact test
/// can raise a trust prompt just like a live session. Bounded like one:
/// the connect by the connector's overall deadline, the close by
/// `CLOSE_GRACE` per hop, so an unresponsive host can't hang it.
/// Goes through the target's jump host when it has one, exactly like a
/// connect. The result is the auth outcome, not the teardown.
pub async fn test_connection(
    ssh: &SshConnector,
    target: SshTarget,
    prompter: Arc<dyn ConnectPrompter>,
) -> Result<(), AppError> {
    let handler = ssh
        .handler(target.host.clone(), target.port, target.keepalive, prompter)
        .with_purpose("connection test");
    let jump = target.jump.as_ref();
    let connection = ssh.connect(target.endpoint(), jump, handler).await?;
    connection.close().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_shell_end_says_who_or_what_ended_it() {
        let lost = Ok(SessionStatus::Disconnected);
        assert_eq!(shell_end(&lost, true), "closed by the user");
        assert_eq!(
            shell_end(&Ok(SessionStatus::Exited), false),
            "the shell exited"
        );
        assert!(shell_end(&lost, false).contains("ended"));
        let failed = Err(AppError::SshChannel("PTY request failed".into()));
        assert!(shell_end(&failed, false).contains("PTY request failed"));
    }

    #[tokio::test]
    async fn keystrokes_typed_while_connecting_are_dropped() {
        let (input_tx, mut input) = mpsc::channel(4);
        input_tx.send(b"early".to_vec()).await.unwrap();
        let (stop_tx, mut stop) = watch::channel(false);
        stop_tx.send_replace(true);

        wait_for_stop(&mut input, &mut stop).await;

        assert!(input.try_recv().is_err());
    }
}
