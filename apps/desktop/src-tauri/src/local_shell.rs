//! Local shell Sessions: `spawn_session` runs one in the `SessionRegistry`
//! (`session_registry.rs`) like a serial one; it opens a PTY, spawns the
//! shell, reports Connected, and ends when the shell exits or on a disconnect.
//!
//! ## PTY, threads & the async bridge
//!
//! Unlike SSH (async `russh`) and serial (async `tokio_serial`), `portable-pty`
//! is **blocking and thread-based**: its reader/writer are `std::io` handles and
//! opening/spawning are synchronous. So a local-shell session bridges that sync
//! world to the async sink with three dedicated OS threads plus one tokio task:
//! - a **reader thread** pumps PTY output into the sink until EOF, or (on
//!   Unix) until the session ends: it polls, so a background job still
//!   holding the terminal can't keep it — and the PTY — alive;
//! - a **writer thread** drains an mpsc of keystroke chunks into the PTY;
//! - a **reaper thread** owns the child: it reports its exit on a `done`
//!   channel, or kills it when the session ends (see `spawn_reaper`);
//! - the **runner** (tokio) owns the master (for `resize`), applies
//!   writes and resizes, and ends the session when the child exits or a
//!   disconnect is requested.
//!
//! There are **no secrets** here (like serial), and auto-reconnect does not apply
//! — a shell exiting is a normal end, surfaced as `Exited` (code 0) or
//! `Disconnected`.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::Arc;
use std::time::Duration;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tokio::sync::mpsc;

use crate::error::AppError;
use crate::flatpak;
use crate::session_registry::{NewSession, Resizes, RunnerControls, SessionRegistry};
use crate::session_sink::{SessionSink, SessionStatus};

/// Read buffer for the PTY→terminal pump. 4 KiB covers a burst of shell output
/// between reads without oversizing each copy (matches the serial pump).
const READ_BUFFER_SIZE: usize = 4096;
/// How long a Unix reader waits on a quiet PTY before checking whether its
/// session ended.
#[cfg(unix)]
const READ_POLL_TIMEOUT: Duration = Duration::from_millis(100);
/// `LANG` for a macOS shell when the app started without one.
const MACOS_FALLBACK_LANG: &str = "en_US.UTF-8";

/// The connection-shaped params for a local shell session (mirrors
/// `session::ConnectParams` / `serial::SerialParams`). Built by the `connect`
/// command from a `Connection::LocalShell` device plus the pane's size.
pub struct LocalShellParams {
    /// Explicit shell binary, or `None` to use the OS default (see
    /// [`resolve_program`]).
    pub shell: Option<String>,
    /// Startup working directory, or `None` for the user's home (see
    /// [`resolve_cwd`]).
    pub cwd: Option<String>,
    /// Initial terminal size; the frontend follows up with `resize_pty` as the
    /// pane is laid out.
    pub cols: u32,
    pub rows: u32,
    /// Optional commands to type into the shell once it is ready (the device's
    /// connect snippet). Sent verbatim (each line terminated with `\r`); `None` ⇒
    /// nothing is sent.
    pub connect_snippet: Option<String>,
}

/// The blocking handles produced by opening a PTY and spawning the shell into
/// it, handed back from a `spawn_blocking` to the async control task. Every
/// field is `Send`, so the whole bundle moves across the await.
struct OpenedShell {
    master: Box<dyn MasterPty + Send>,
    reader: PtyReader,
    writer: Box<dyn Write + Send>,
    /// The spawned child, moved into its reaper thread (see [`spawn_reaper`]).
    child: Box<dyn Child + Send + Sync>,
}

/// How often the reaper checks whether the shell has exited.
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Resolve the shell program to launch: an explicit non-empty `shell`, else the
/// OS default. On Windows, prefer PowerShell 7 (`pwsh`) then Windows PowerShell,
/// falling back to `ComSpec`/`cmd.exe`; on Unix, `$SHELL` then `/bin/sh`.
fn resolve_program(shell: &Option<String>) -> String {
    if let Some(s) = shell {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    default_program()
}

#[cfg(windows)]
fn default_program() -> String {
    // Prefer pwsh (PowerShell 7+), then the always-present Windows PowerShell,
    // then the classic shell. `pwsh` is only used if it is actually on PATH so a
    // missing install falls through rather than failing the spawn.
    for candidate in ["pwsh.exe", "powershell.exe"] {
        if is_on_path(candidate) {
            return candidate.to_string();
        }
    }
    std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string())
}

#[cfg(not(windows))]
fn default_program() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
}

/// Whether `program` resolves on the `PATH` (used only to decide the Windows
/// default shell). A best-effort existence check across `PATH` entries.
#[cfg(windows)]
fn is_on_path(program: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| dir.join(program).is_file())
}

/// Resolve the startup directory: an explicit non-empty `cwd`, else the user's
/// home. `None` when neither is available (the child then inherits the app's
/// working directory).
fn resolve_cwd(cwd: &Option<String>) -> Option<String> {
    if let Some(c) = cwd {
        let trimmed = c.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    home_dir()
}

fn home_dir() -> Option<String> {
    // USERPROFILE on Windows, HOME elsewhere — no extra crate needed.
    #[cfg(windows)]
    let key = "USERPROFILE";
    #[cfg(not(windows))]
    let key = "HOME";
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

fn build_command(params: &LocalShellParams) -> CommandBuilder {
    if flatpak::is_sandboxed() {
        return host_command(&resolve_program(&params.shell), resolve_cwd(&params.cwd));
    }
    native_command(params)
}

/// Inside the Flatpak sandbox a shell would only see the runtime, not the
/// user's system, so it runs on the host through `flatpak-spawn --host`. The
/// PTY stays ours (its fds are forwarded) and the host shell gets the host's
/// environment; only `TERM` is passed along. `--watch-bus` kills it if the app
/// goes away.
///
/// A tty can be the controlling terminal of one session only. If the sandboxed
/// `flatpak-spawn` took it, the host shell would run without one: no job
/// control and no SIGWINCH on resize. Left free, the host side claims it.
fn host_command(program: &str, cwd: Option<String>) -> CommandBuilder {
    let mut cmd = CommandBuilder::new("flatpak-spawn");
    cmd.set_controlling_tty(false);
    cmd.args(["--host", "--watch-bus", "--env=TERM=xterm-256color"]);
    if let Some(dir) = cwd {
        cmd.arg(format!("--directory={dir}"));
    }
    cmd.arg(program);
    cmd
}

/// The shell as a direct child: the resolved program, the resolved startup
/// directory (when known), `TERM=xterm-256color` so full-screen programs behave
/// (matching the SSH session's `TERM`), and the app's own environment.
fn native_command(params: &LocalShellParams) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(resolve_program(&params.shell));
    if let Some(dir) = resolve_cwd(&params.cwd) {
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");
    if cfg!(target_os = "macos") {
        apply_macos_login_env(&mut cmd, is_default_shell(&params.shell));
    }
    cmd
}

/// A macOS app launched from Finder inherits launchd's bare environment: a
/// minimal `PATH` (no Homebrew) and no `LANG` (zsh then garbles non-ASCII
/// input). Like Terminal.app, run the default shell as a login shell so
/// `/etc/zprofile` and `~/.zprofile` set `PATH`, and fall back to a UTF-8
/// locale. An explicit shell setting may be any program, so it gets no `-l`.
fn apply_macos_login_env(cmd: &mut CommandBuilder, default_shell: bool) {
    if default_shell {
        cmd.arg("-l");
    }
    if cmd.get_env("LANG").is_none_or(|lang| lang.is_empty()) {
        cmd.env("LANG", MACOS_FALLBACK_LANG);
    }
}

fn is_default_shell(shell: &Option<String>) -> bool {
    shell.as_deref().is_none_or(|s| s.trim().is_empty())
}

/// Open a PTY and spawn the shell into it — the only OS-touching call, isolated
/// so it runs on a `spawn_blocking` and its failure maps to a clean `Io` error.
/// Carries nothing secret (local shells have no secrets).
fn open_shell(params: &LocalShellParams) -> Result<OpenedShell, AppError> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(pty_size(params.cols, params.rows))
        .map_err(|e| AppError::Io(format!("could not open a pseudo-terminal: {e}")))?;

    let child = pair
        .slave
        .spawn_command(build_command(params))
        .map_err(|e| {
            AppError::Io(format!(
                "could not start the shell '{}': {e}",
                resolve_program(&params.shell)
            ))
        })?;
    // The slave end is held by the spawned child now; drop our handle so the PTY
    // reports EOF once the child (and any of its children) close it.
    drop(pair.slave);

    let reader = PtyReader::open(pair.master.as_ref())
        .map_err(|e| AppError::Io(format!("could not read from the shell: {e}")))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| AppError::Io(format!("could not write to the shell: {e}")))?;

    Ok(OpenedShell {
        master: pair.master,
        reader,
        writer,
        child,
    })
}

/// A terminal size a PTY takes: clamped to `u16`, at least 1×1.
fn pty_size(cols: u32, rows: u32) -> PtySize {
    let clamp = |cells: u32| u16::try_from(cells).unwrap_or(u16::MAX).max(1);
    PtySize {
        rows: clamp(rows),
        cols: clamp(cols),
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Start a local shell Session in `registry`.
pub fn spawn_session(
    registry: &Arc<SessionRegistry>,
    session: NewSession,
    params: LocalShellParams,
) {
    registry.spawn(session, |controls, sink| {
        run_session(params, sink, controls)
    });
}

/// The full lifecycle of one local shell session: open the PTY + spawn the
/// shell (reporting Connected on success), pump bytes both ways via dedicated
/// threads, and end when the shell exits or a disconnect is requested. Returns
/// the final status for a clean end (`Exited` when the shell ended on its own
/// with exit code 0 or the PTY writer is gone, `Disconnected` when asked to or
/// on any other end) and
/// `Err` for a failure that should surface as `session_status: error`.
async fn run_session(
    params: LocalShellParams,
    sink: Arc<dyn SessionSink>,
    mut controls: RunnerControls,
) -> Result<SessionStatus, AppError> {
    let snippet = crate::device::connect_snippet_bytes(params.connect_snippet.as_deref());
    let opened = open_shell_off_runtime(params).await?;
    sink.on_status(SessionStatus::Connected, None);
    let mut shell = LiveShell::start(opened, sink);
    // Best-effort: if the writer is already gone, the next write ends the
    // session.
    if let Some(bytes) = snippet {
        let _ = shell.write_tx.send(bytes);
    }
    let status = pump_controls(&mut controls, &mut shell).await;
    shell.close();
    Ok(status)
}

/// Opening the PTY and spawning are blocking; they run off the async runtime.
async fn open_shell_off_runtime(params: LocalShellParams) -> Result<OpenedShell, AppError> {
    tokio::task::spawn_blocking(move || open_shell(&params))
        .await
        .map_err(|e| AppError::Io(format!("shell spawn task failed: {e}")))?
}

/// A running shell: the runner's ends of its threads, and the master (for
/// resizes).
struct LiveShell {
    master: Box<dyn MasterPty + Send>,
    write_tx: std::sync::mpsc::Sender<Vec<u8>>,
    /// The shell's exit code, once it exits on its own.
    done_rx: mpsc::Receiver<Option<u32>>,
    kill_tx: std::sync::mpsc::Sender<()>,
    reader_done: Arc<AtomicBool>,
}

impl LiveShell {
    fn start(opened: OpenedShell, sink: Arc<dyn SessionSink>) -> Self {
        let (kill_tx, kill_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel(1);
        spawn_reaper(opened.child, kill_rx, done_tx);
        LiveShell {
            master: opened.master,
            write_tx: spawn_writer(opened.writer),
            done_rx,
            kill_tx,
            reader_done: spawn_output_pump(opened.reader, sink),
        }
    }

    /// Have the reaper kill the child (a no-op if it already exited), end the
    /// writer thread by dropping its sender, and drop the master so the PTY
    /// closes and the reader thread returns.
    fn close(self) {
        drop(self.kill_tx);
        self.reader_done.store(true, Ordering::Relaxed);
        drop(self.write_tx);
        drop(self.master);
    }
}

/// Start the reader thread (see [`pump_output`]); setting the returned flag
/// stops it.
fn spawn_output_pump(reader: PtyReader, sink: Arc<dyn SessionSink>) -> Arc<AtomicBool> {
    let reader_done = Arc::new(AtomicBool::new(false));
    let stop = Arc::clone(&reader_done);
    std::thread::spawn(move || pump_output(reader, sink.as_ref(), &stop));
    reader_done
}

/// Writer thread: drain keystroke chunks into the PTY. A std mpsc bridges the
/// async control task (non-blocking `send`) to the blocking writer; dropping
/// the returned sender ends the thread.
fn spawn_writer(mut writer: Box<dyn Write + Send>) -> std::sync::mpsc::Sender<Vec<u8>> {
    let (write_tx, write_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        while let Ok(bytes) = write_rx.recv() {
            if writer.write_all(&bytes).is_err() {
                break;
            }
            let _ = writer.flush();
        }
    });
    write_tx
}

/// Run until the shell exits on its own, a disconnect, or the input ends it;
/// returns the final status. Biased, so a disconnect wins over input still
/// queued.
async fn pump_controls(controls: &mut RunnerControls, shell: &mut LiveShell) -> SessionStatus {
    let RunnerControls {
        input,
        resizes,
        stop,
    } = controls;
    tokio::select! {
        biased;
        _ = stop.wait_for(|stopped| *stopped) => SessionStatus::Disconnected,
        exit_code = shell.done_rx.recv() => SessionStatus::for_shell_exit(exit_code.flatten()),
        status = apply_controls(input, resizes, &shell.write_tx, shell.master.as_mut()) => status,
    }
}

/// Apply writes and resizes until a write ends the session.
async fn apply_controls(
    input: &mut mpsc::Receiver<Vec<u8>>,
    resizes: &mut Resizes,
    write_tx: &std::sync::mpsc::Sender<Vec<u8>>,
    master: &mut (dyn MasterPty + Send),
) -> SessionStatus {
    loop {
        if let Some(status) = apply_next_control(input, resizes, write_tx, master).await {
            return status;
        }
    }
}

/// Apply the next write or resize; `Some` with the final status when it ends
/// the session.
async fn apply_next_control(
    input: &mut mpsc::Receiver<Vec<u8>>,
    resizes: &mut Resizes,
    write_tx: &std::sync::mpsc::Sender<Vec<u8>>,
    master: &mut (dyn MasterPty + Send),
) -> Option<SessionStatus> {
    tokio::select! {
        bytes = input.recv() => write_input(bytes, write_tx),
        (cols, rows) = resizes.next() => {
            let _ = master.resize(pty_size(cols, rows));
            None
        }
    }
}

fn write_input(
    bytes: Option<Vec<u8>>,
    write_tx: &std::sync::mpsc::Sender<Vec<u8>>,
) -> Option<SessionStatus> {
    match bytes {
        // Writer thread gone ⇒ PTY is dead; end the session.
        Some(bytes) => write_tx.send(bytes).err().map(|_| SessionStatus::Exited),
        // The input closed: the session is gone.
        None => Some(SessionStatus::Disconnected),
    }
}

/// Reader thread: pump PTY output into the sink until EOF or a read error
/// (both mean the shell/PTY is gone), or until `stop` is set. `sink` is
/// `Send + Sync`, so it is called directly from the thread.
fn pump_output(mut reader: PtyReader, sink: &dyn SessionSink, stop: &AtomicBool) {
    let mut buf = [0u8; READ_BUFFER_SIZE];
    while !stop.load(Ordering::Relaxed) {
        match reader.read_ready(&mut buf) {
            Ok(Some(0)) | Err(_) => break,
            Ok(Some(count)) => sink.on_data(&buf[..count]),
            Ok(None) => {}
        }
    }
}

/// The thread that owns the shell process: it reports the exit code on `done`
/// once the shell exits, or kills it when `kill` fires or is dropped.
/// portable-pty's `kill` on the child itself sends SIGHUP and, if the shell is
/// still there after a short grace (one ignoring the hangup and EOF), SIGKILL;
/// owning the child means it is never signalled after being reaped.
fn spawn_reaper(
    mut child: Box<dyn Child + Send + Sync>,
    kill: std::sync::mpsc::Receiver<()>,
    done: mpsc::Sender<Option<u32>>,
) {
    std::thread::spawn(move || {
        let exit_code = wait_or_kill(child.as_mut(), &kill);
        let _ = done.blocking_send(exit_code);
    });
}

fn wait_or_kill(
    child: &mut (dyn Child + Send + Sync),
    kill: &std::sync::mpsc::Receiver<()>,
) -> Option<u32> {
    loop {
        if let Some(exited) = try_exit_code(child) {
            return exited;
        }
        if kill.recv_timeout(EXIT_POLL_INTERVAL) != Err(RecvTimeoutError::Timeout) {
            let _ = child.kill();
            return child.wait().ok().map(|status| status.exit_code());
        }
    }
}

/// `Some(exit code)` once the shell has exited (`Some(None)` when its status
/// can't be read), `None` while it runs.
fn try_exit_code(child: &mut (dyn Child + Send + Sync)) -> Option<Option<u32>> {
    match child.try_wait() {
        Ok(Some(status)) => Some(Some(status.exit_code())),
        Ok(None) => None,
        Err(_) => Some(None),
    }
}

/// The PTY's output end, owned by the reader thread. On Unix it is a copy of
/// the master's descriptor that the thread polls, so it can let go when the
/// session ends: the PTY only closes once every master descriptor is, and a
/// blocked read would hold this one for as long as any child (a disowned
/// job, or a background one under a shell that doesn't hang its jobs up)
/// keeps the terminal open.
#[cfg(unix)]
struct PtyReader(std::fs::File);

#[cfg(unix)]
impl PtyReader {
    fn open(master: &(dyn MasterPty + Send)) -> std::io::Result<Self> {
        use std::os::fd::BorrowedFd;
        let fd = master
            .as_raw_fd()
            .ok_or_else(|| std::io::Error::other("the PTY has no descriptor"))?;
        // SAFETY: `fd` belongs to `master`, which is borrowed (so open) here.
        let owned = unsafe { BorrowedFd::borrow_raw(fd) }.try_clone_to_owned()?;
        Ok(PtyReader(std::fs::File::from(owned)))
    }

    /// Read what is available, or `None` when nothing came within
    /// [`READ_POLL_TIMEOUT`]. A descriptor `select(2)` can't watch (macOS,
    /// fd ≥ 1024) falls back to a blocking read rather than losing output.
    fn read_ready(&mut self, buf: &mut [u8]) -> std::io::Result<Option<usize>> {
        use std::os::fd::AsRawFd;
        let mut poll_fd = [filedescriptor::pollfd {
            fd: self.0.as_raw_fd(),
            events: filedescriptor::POLLIN,
            revents: 0,
        }];
        match filedescriptor::poll(&mut poll_fd, Some(READ_POLL_TIMEOUT)) {
            Ok(0) => Ok(None),
            Err(err) if is_interrupted(&err) => Ok(None),
            Ok(_) | Err(_) => self.0.read(buf).map(Some),
        }
    }
}

/// A poll cut short by a signal is just another quiet interval.
#[cfg(unix)]
fn is_interrupted(err: &filedescriptor::Error) -> bool {
    match err {
        filedescriptor::Error::Poll(io) | filedescriptor::Error::Io(io) => {
            io.kind() == std::io::ErrorKind::Interrupted
        }
        _ => false,
    }
}

/// On Windows the reader stays a blocking one, as before (ConPTY has no
/// descriptor to poll).
#[cfg(windows)]
struct PtyReader(Box<dyn Read + Send>);

#[cfg(windows)]
impl PtyReader {
    fn open(master: &(dyn MasterPty + Send)) -> std::io::Result<Self> {
        let reader = master
            .try_clone_reader()
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        Ok(PtyReader(reader))
    }

    fn read_ready(&mut self, buf: &mut [u8]) -> std::io::Result<Option<usize>> {
        self.0.read(buf).map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_registry::{open_channels, SessionRegistry};
    use crate::session_sink::testing::RecordingSink;

    fn spawn_shell(registry: &Arc<SessionRegistry>, shell: &str, sink: &Arc<RecordingSink>) {
        let params = LocalShellParams {
            shell: Some(shell.to_string()),
            cwd: None,
            cols: 80,
            rows: 24,
            connect_snippet: None,
        };
        let session = NewSession {
            id: "ls1".to_string(),
            sink: Arc::clone(sink) as Arc<dyn SessionSink>,
        };
        spawn_session(registry, session, params);
    }

    /// A shell around a bare PTY, with no threads: writes fail as if the
    /// writer thread were gone. The shell runs while the returned sender lives.
    #[cfg(unix)]
    fn detached_shell() -> (LiveShell, mpsc::Sender<Option<u32>>) {
        let pair = native_pty_system().openpty(pty_size(80, 24)).unwrap();
        let (write_tx, _) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel(1);
        let (kill_tx, _) = std::sync::mpsc::channel();
        let shell = LiveShell {
            master: pair.master,
            write_tx,
            done_rx,
            kill_tx,
            reader_done: Arc::new(AtomicBool::new(false)),
        };
        (shell, done_tx)
    }

    #[test]
    fn a_terminal_size_is_clamped_to_what_a_pty_takes() {
        let size = pty_size(70_000, 0);

        assert_eq!((size.cols, size.rows), (u16::MAX, 1));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_resize_clamps_the_size() {
        let (mut shell, _done_tx) = detached_shell();
        let (handle, mut controls) = open_channels();
        handle.size.send_replace(Some((70_000, 30)));

        let master = shell.master.as_mut();
        let end = apply_next_control(
            &mut controls.input,
            &mut controls.resizes,
            &shell.write_tx,
            master,
        );

        assert_eq!(end.await, None);
        let size = shell.master.get_size().unwrap();
        assert_eq!((size.cols, size.rows), (u16::MAX, 30));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_write_to_a_dead_pty_ends_the_session() {
        let (mut shell, _done_tx) = detached_shell();
        let (handle, mut controls) = open_channels();
        handle.input.send(b"x".to_vec()).await.unwrap();

        let status = pump_controls(&mut controls, &mut shell).await;

        assert_eq!(status, SessionStatus::Exited);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_disconnect_ends_the_session_even_with_a_write_queued() {
        let (mut shell, _done_tx) = detached_shell();
        let (handle, mut controls) = open_channels();
        handle.input.send(b"x".to_vec()).await.unwrap();
        handle.stop.send_replace(true);

        // A write applied first would end the session as Exited.
        let status = pump_controls(&mut controls, &mut shell).await;

        assert_eq!(status, SessionStatus::Disconnected);
    }

    #[test]
    fn resolve_program_prefers_explicit_shell() {
        assert_eq!(
            resolve_program(&Some("/usr/bin/fish".to_string())),
            "/usr/bin/fish"
        );
        // Blank ⇒ falls back to the OS default (non-empty).
        assert!(!resolve_program(&Some("   ".to_string())).is_empty());
        assert!(!resolve_program(&None).is_empty());
    }

    #[test]
    fn macos_default_shell_is_a_login_shell_with_a_utf8_locale() {
        let mut cmd = CommandBuilder::new("/bin/zsh");
        cmd.env_remove("LANG");

        apply_macos_login_env(&mut cmd, true);

        assert_eq!(cmd.get_argv(), &vec!["/bin/zsh", "-l"]);
        assert_eq!(cmd.get_env("LANG"), Some("en_US.UTF-8".as_ref()));
    }

    #[test]
    fn macos_keeps_an_explicit_shell_and_the_users_locale() {
        let mut cmd = CommandBuilder::new("/usr/local/bin/fish");
        cmd.env("LANG", "fr_FR.UTF-8");

        apply_macos_login_env(&mut cmd, false);

        assert_eq!(cmd.get_argv(), &vec!["/usr/local/bin/fish"]);
        assert_eq!(cmd.get_env("LANG"), Some("fr_FR.UTF-8".as_ref()));
    }

    #[test]
    fn only_a_blank_shell_setting_means_the_default_shell() {
        assert!(is_default_shell(&None));
        assert!(is_default_shell(&Some("  ".to_string())));
        assert!(!is_default_shell(&Some("/bin/bash".to_string())));
    }

    #[test]
    fn resolve_cwd_prefers_explicit_dir() {
        assert_eq!(
            resolve_cwd(&Some("/tmp/work".to_string())),
            Some("/tmp/work".to_string())
        );
        // Blank ⇒ home or None, never the blank string.
        assert_ne!(resolve_cwd(&Some("  ".to_string())), Some("  ".to_string()));
    }

    #[test]
    fn in_a_flatpak_the_shell_runs_on_the_host_via_flatpak_spawn() {
        let cmd = host_command("/bin/bash", Some("/home/j/work".to_string()));

        assert_eq!(
            cmd.get_argv(),
            &vec![
                "flatpak-spawn",
                "--host",
                "--watch-bus",
                "--env=TERM=xterm-256color",
                "--directory=/home/j/work",
                "/bin/bash",
            ]
        );
    }

    #[test]
    fn a_host_shell_leaves_the_pty_free_to_be_its_controlling_terminal() {
        let cmd = host_command("/bin/bash", None);

        assert!(!cmd.get_controlling_tty());
    }

    #[test]
    fn a_host_shell_without_a_known_dir_starts_where_the_host_decides() {
        let cmd = host_command("/bin/zsh", None);

        assert_eq!(
            cmd.get_argv(),
            &vec![
                "flatpak-spawn",
                "--host",
                "--watch-bus",
                "--env=TERM=xterm-256color",
                "/bin/zsh",
            ]
        );
    }

    /// End-to-end: spawn a real shell and confirm the lifecycle + read pump +
    /// teardown. Uses a fast shell per OS (`cmd.exe` / `/bin/sh`). No hardware
    /// needed (unlike serial).
    ///
    /// The interactive command round-trip is asserted only on Unix: under
    /// Windows ConPTY the pty emits a cursor-position query (`ESC[6n`) and the
    /// shell waits for the terminal to answer before it echoes — the real app's
    /// xterm.js answers automatically, but this headless test does not, so on
    /// Windows we assert only that the shell spawned and produced output.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn spawns_shell_reports_lifecycle_and_reads_output() {
        let shell = if cfg!(windows) {
            "cmd.exe".to_string()
        } else {
            "/bin/sh".to_string()
        };
        let registry = Arc::new(SessionRegistry::new());
        let sink = Arc::new(RecordingSink::default());
        spawn_shell(&registry, &shell, &sink);

        // Let the shell come up and emit its initial output (prompt / pty setup).
        let mut got_output = false;
        for _ in 0..60 {
            if !sink.text().is_empty() {
                got_output = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(got_output, "expected the shell to produce some output");
        assert_eq!(sink.statuses().first(), Some(&SessionStatus::Connecting));
        assert!(sink.statuses().contains(&SessionStatus::Connected));

        // On Unix, also verify the write path: a `sh` echoes the marker back
        // without needing a DSR answer.
        #[cfg(not(windows))]
        {
            registry
                .write_stdin("ls1", b"echo DASH_MARKER_OK\n".to_vec())
                .await;
            let mut seen = false;
            for _ in 0..60 {
                if sink.text().contains("DASH_MARKER_OK") {
                    seen = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            assert!(
                seen,
                "expected the shell to echo the marker; got: {:?}",
                sink.text()
            );
        }

        registry.disconnect_all().await;
        assert_eq!(registry.session_count(), 0);
    }

    /// A background job still holding the PTY must not keep the reader thread
    /// (and with it the PTY) alive once the session ends. Disowned, so no shell
    /// hangs it up on exit: bash would, dash (`/bin/sh` on Ubuntu) never does.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_background_job_does_not_keep_the_reader_alive() {
        let registry = Arc::new(SessionRegistry::new());
        let sink = Arc::new(RecordingSink::default());
        spawn_shell(&registry, "/bin/sh", &sink);
        registry
            .write_stdin("ls1", b"sleep 5 & disown; echo JOB_STARTED\n".to_vec())
            .await;
        for _ in 0..60 {
            if sink.text().contains("JOB_STARTED\r\n") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        registry.disconnect_all().await;

        // Only the test's own reference is left once every thread let go.
        for _ in 0..50 {
            if Arc::strong_count(&sink) == 1 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the reader thread outlived the session");
    }

    /// A shell that ignores both the hangup and EOF is killed once the
    /// session ends, so it can't keep the PTY and the reader thread alive.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_shell_ignoring_hangup_and_eof_is_killed() {
        if !std::path::Path::new("/bin/bash").exists() {
            return;
        }
        let registry = Arc::new(SessionRegistry::new());
        let sink = Arc::new(RecordingSink::default());
        spawn_shell(&registry, "/bin/bash", &sink);
        // The quotes keep the echoed command line from matching the output.
        registry
            .write_stdin(
                "ls1",
                b"trap '' HUP; set -o ignoreeof; echo AR''MED\n".to_vec(),
            )
            .await;
        for _ in 0..60 {
            if sink.text().contains("ARMED\r\n") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(sink.text().contains("ARMED\r\n"), "got: {:?}", sink.text());

        registry.disconnect_all().await;

        for _ in 0..150 {
            if Arc::strong_count(&sink) == 1 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the shell outlived the session");
    }
}
