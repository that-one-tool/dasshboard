//! Local shell session core — the local-terminal analogue of `session.rs`'s
//! `SessionManager` and `serial.rs`'s `SerialSessionManager`. It **reuses** the
//! Tauri-free [`SessionSink`] + [`SessionStatus`] seam (no parallel event
//! system): a local shell emits Connecting → Connected → Disconnected/Error over
//! the same sink an SSH or serial session does, so the frontend pane treats all
//! three identically.
//!
//! ## PTY, threads & the async bridge
//!
//! Unlike SSH (async `russh`) and serial (async `tokio_serial`), `portable-pty`
//! is **blocking and thread-based**: its reader/writer are `std::io` handles and
//! opening/spawning are synchronous. So a local-shell session bridges that sync
//! world to the async sink with two dedicated OS threads plus one tokio task:
//! - a **reader thread** pumps PTY output into the sink until EOF, or (on
//!   Unix) until the session ends: it polls, so a background job still
//!   holding the terminal can't keep it — and the PTY — alive;
//! - a **writer thread** drains an mpsc of keystroke chunks into the PTY;
//! - the **control task** (tokio) owns the master (for `resize`) and a child
//!   killer, applies control messages, and ends the session when the child exits
//!   (a blocking `wait` fires a `done` channel) or a disconnect is requested.
//!
//! There are **no secrets** here (like serial), and auto-reconnect does not apply
//! — a shell exiting is a normal end, surfaced as `Disconnected`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tokio::sync::mpsc;

use crate::error::AppError;
use crate::flatpak;
use crate::session::{SessionSink, SessionStatus};

/// Bound on the per-session control channel — same rationale as the SSH/serial
/// sessions': keeps it from being unbounded; keyboard-rate input never backs up.
const CONTROL_CHANNEL_CAPACITY: usize = 256;
/// Read buffer for the PTY→terminal pump. 4 KiB covers a burst of shell output
/// between reads without oversizing each copy (matches the serial pump).
const READ_BUFFER_SIZE: usize = 4096;
/// How long a Unix reader waits on a quiet PTY before checking whether its
/// session ended.
#[cfg(unix)]
const READ_POLL_TIMEOUT_MS: i32 = 100;
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
    pub cols: u16,
    pub rows: u16,
    /// Optional commands to type into the shell once it is ready (the device's
    /// connect snippet). Sent verbatim (each line terminated with `\r`); `None` ⇒
    /// nothing is sent.
    pub connect_snippet: Option<String>,
}

/// Control messages to a local shell session task.
enum ShellControl {
    Write(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Disconnect,
}

/// Per-session handle: just the control `Sender`. Dropping every clone (the
/// manager forgetting the session) makes the task's `recv()` return `None`,
/// which it treats as a disconnect.
struct ShellHandle {
    control: mpsc::Sender<ShellControl>,
}

/// The blocking handles produced by opening a PTY and spawning the shell into
/// it, handed back from a `spawn_blocking` to the async control task. Every
/// field is `Send`, so the whole bundle moves across the await.
struct OpenedShell {
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    reader: PtyReader,
    writer: Box<dyn Write + Send>,
    /// The spawned child, moved into a blocking `wait` task to detect exit.
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

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

/// TLS trust-store overrides `tauri-plugin-updater` sets process-wide on Linux
/// during an update check (when unset). Its paths are Debian's; on Fedora/RHEL
/// the file doesn't exist, so OpenSSL-based tools in a shell that inherited
/// them fail certificate checks. A shell keeps them only if the app started
/// with them.
const UPDATER_TLS_VARS: [&str; 2] = ["SSL_CERT_FILE", "SSL_CERT_DIR"];

/// Where distributions keep the trust store for each of
/// [`UPDATER_TLS_VARS`]; the first one that exists is used.
const CA_BUNDLES: [&str; 5] = [
    "/etc/ssl/certs/ca-certificates.crt", // Debian, Ubuntu, Arch
    "/etc/pki/tls/certs/ca-bundle.crt",   // Fedora, RHEL
    "/etc/ssl/ca-bundle.pem",             // openSUSE
    "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem", // CentOS
    "/etc/ssl/cert.pem",                  // Alpine
];
const CA_DIRS: [&str; 2] = ["/etc/ssl/certs", "/etc/pki/tls/certs"];

static TLS_VARS_AT_STARTUP: OnceLock<Vec<&'static str>> = OnceLock::new();
static TLS_VARS_PRESET: OnceLock<Vec<&'static str>> = OnceLock::new();

/// Records which [`UPDATER_TLS_VARS`] the app started with. Called first thing
/// in `run`, before any update check can set them.
pub fn record_startup_env() {
    TLS_VARS_AT_STARTUP.get_or_init(present_tls_vars);
}

/// Sets the [`UPDATER_TLS_VARS`] the app didn't start with to this system's
/// own trust store, so the updater (which sets Debian's paths when they are
/// unset) never changes the environment while other threads read it, and
/// what inherits them (the restart after an update, xdg-open) gets working
/// paths. Linux only, like the updater's change; call first thing in `run`,
/// after [`record_startup_env`] and before any thread exists.
pub fn preset_tls_env() {
    if !cfg!(target_os = "linux") {
        return;
    }
    let presets = tls_presets(&tls_vars_not_inherited(), |path| {
        std::path::Path::new(path).exists()
    });
    for (var, path) in &presets {
        std::env::set_var(var, path);
    }
    let _ = TLS_VARS_PRESET.set(presets.into_iter().map(|(var, _)| var).collect());
}

/// Removes the [`UPDATER_TLS_VARS`] an update check set — only possible where
/// no trust store was found to preset — right after the check.
pub fn drop_updater_tls_env() {
    let startup = TLS_VARS_AT_STARTUP.get_or_init(present_tls_vars);
    let preset = TLS_VARS_PRESET.get().map(Vec::as_slice).unwrap_or_default();
    for var in updater_set_vars(startup, preset, |var| std::env::var_os(var).is_some()) {
        std::env::remove_var(var);
    }
}

/// The [`UPDATER_TLS_VARS`] a child process must not inherit: those the app
/// didn't start with (preset, or set by the updater).
pub fn tls_vars_not_inherited() -> Vec<&'static str> {
    vars_to_scrub(TLS_VARS_AT_STARTUP.get_or_init(present_tls_vars))
}

fn tls_presets(
    missing: &[&'static str],
    exists: impl Fn(&str) -> bool,
) -> Vec<(&'static str, &'static str)> {
    missing
        .iter()
        .filter_map(|&var| {
            let candidates: &[&'static str] = if var == "SSL_CERT_FILE" {
                &CA_BUNDLES
            } else {
                &CA_DIRS
            };
            candidates
                .iter()
                .find(|path| exists(path))
                .map(|&path| (var, path))
        })
        .collect()
}

fn updater_set_vars(
    at_startup: &[&str],
    preset: &[&str],
    is_set: impl Fn(&str) -> bool,
) -> Vec<&'static str> {
    vars_to_scrub(at_startup)
        .into_iter()
        .filter(|var| !preset.contains(var) && is_set(var))
        .collect()
}

fn present_tls_vars() -> Vec<&'static str> {
    UPDATER_TLS_VARS
        .into_iter()
        .filter(|var| std::env::var_os(var).is_some())
        .collect()
}

fn vars_to_scrub(present_at_startup: &[&str]) -> Vec<&'static str> {
    UPDATER_TLS_VARS
        .into_iter()
        .filter(|var| !present_at_startup.contains(var))
        .collect()
}

fn scrub_env(cmd: &mut CommandBuilder, vars: &[&str]) {
    for var in vars {
        cmd.env_remove(var);
    }
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
/// (matching the SSH session's `TERM`), and the app's own environment minus the
/// updater's TLS overrides.
fn native_command(params: &LocalShellParams) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(resolve_program(&params.shell));
    if let Some(dir) = resolve_cwd(&params.cwd) {
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");
    scrub_env(&mut cmd, &tls_vars_not_inherited());
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
        .openpty(PtySize {
            rows: params.rows.max(1),
            cols: params.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
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
    let killer = child.clone_killer();

    Ok(OpenedShell {
        master: pair.master,
        killer,
        reader,
        writer,
        child,
    })
}

/// The full lifecycle of one local shell session: open the PTY + spawn the shell
/// (reporting Connected on success), pump bytes both ways via dedicated threads,
/// and end when the shell exits or a disconnect is requested. Returns the final
/// status for a clean end (`Exited` when the shell ended on its own with exit
/// code 0, `Disconnected` when asked to or on any other end) and `Err` for a failure that should surface as
/// `session_status: error`.
async fn run_session(
    params: LocalShellParams,
    sink: Arc<dyn SessionSink>,
    mut control_rx: mpsc::Receiver<ShellControl>,
) -> Result<SessionStatus, AppError> {
    // Capture the connect snippet before `params` moves into the blocking open.
    let connect_snippet = params.connect_snippet.clone();
    // Opening the PTY and spawning are blocking; do them off the async runtime.
    let opened = tokio::task::spawn_blocking(move || open_shell(&params))
        .await
        .map_err(|e| AppError::Io(format!("shell spawn task failed: {e}")))??;

    sink.on_status(SessionStatus::Connected, None);

    let OpenedShell {
        master,
        mut killer,
        reader,
        writer,
        mut child,
    } = opened;

    let reader_done = Arc::new(AtomicBool::new(false));
    let reader_sink = Arc::clone(&sink);
    let stop = Arc::clone(&reader_done);
    std::thread::spawn(move || pump_output(reader, reader_sink.as_ref(), &stop));

    // Writer thread: drain keystroke chunks into the PTY. A std mpsc bridges the
    // async control task (non-blocking `send`) to the blocking writer.
    let (write_tx, write_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut writer = writer;
        while let Ok(bytes) = write_rx.recv() {
            if writer.write_all(&bytes).is_err() {
                break;
            }
            let _ = writer.flush();
        }
    });

    // Connect snippet: type the device's saved commands into the fresh shell via
    // the writer thread. Best-effort — if the writer is already gone the send
    // fails harmlessly and the loop below will end the session on the next write.
    if let Some(bytes) = crate::device::connect_snippet_bytes(connect_snippet.as_deref()) {
        let _ = write_tx.send(bytes);
    }

    // Detect the shell exiting on its own: a blocking `wait` fires `done`.
    let (done_tx, mut done_rx) = mpsc::channel::<Option<u32>>(1);
    std::thread::spawn(move || {
        let exit_code = child.wait().ok().map(|status| status.exit_code());
        let _ = done_tx.blocking_send(exit_code);
    });

    let status = loop {
        tokio::select! {
            ctrl = control_rx.recv() => {
                match ctrl {
                    Some(ShellControl::Write(bytes)) => {
                        // Writer thread gone ⇒ PTY is dead; end the session.
                        if write_tx.send(bytes).is_err() {
                            break SessionStatus::Exited;
                        }
                    }
                    Some(ShellControl::Resize { cols, rows }) => {
                        let _ = master.resize(PtySize {
                            rows: rows.max(1),
                            cols: cols.max(1),
                            pixel_width: 0,
                            pixel_height: 0,
                        });
                    }
                    // Explicit disconnect, or the manager dropped the handle.
                    Some(ShellControl::Disconnect) | None => break SessionStatus::Disconnected,
                }
            }
            // The shell process ended on its own.
            exit_code = done_rx.recv() => break SessionStatus::for_shell_exit(exit_code.flatten()),
        }
    };

    // Teardown: kill the child (idempotent if it already exited), end the writer
    // thread by dropping its sender, and drop the master so the PTY closes and
    // the reader thread returns.
    let _ = killer.kill();
    reader_done.store(true, Ordering::Relaxed);
    drop(write_tx);
    drop(master);
    Ok(status)
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
    /// [`READ_POLL_TIMEOUT_MS`].
    fn read_ready(&mut self, buf: &mut [u8]) -> std::io::Result<Option<usize>> {
        use std::os::fd::AsRawFd;
        let mut poll_fd = libc::pollfd {
            fd: self.0.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: one valid `pollfd`, matching the count passed.
        match unsafe { libc::poll(&mut poll_fd, 1, READ_POLL_TIMEOUT_MS) } {
            0 => Ok(None),
            ready if ready > 0 => self.0.read(buf).map(Some),
            _ => interrupted_as_none(std::io::Error::last_os_error()),
        }
    }
}

/// A poll cut short by a signal is just another quiet interval.
#[cfg(unix)]
fn interrupted_as_none(err: std::io::Error) -> std::io::Result<Option<usize>> {
    match err.kind() {
        std::io::ErrorKind::Interrupted => Ok(None),
        _ => Err(err),
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

/// Owns all live local shell sessions. Lives in Tauri managed state behind an
/// `Arc` (see `AppState`), alongside the SSH and serial managers.
pub struct LocalShellManager {
    sessions: Mutex<HashMap<String, ShellHandle>>,
}

impl Default for LocalShellManager {
    fn default() -> Self {
        Self::new()
    }
}

impl LocalShellManager {
    pub fn new() -> Self {
        LocalShellManager {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    fn lock_sessions(&self) -> std::sync::MutexGuard<'_, HashMap<String, ShellHandle>> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Number of live local shell sessions. Used by the app-close handler
    /// alongside the SSH/serial counts to decide whether a graceful teardown is
    /// needed.
    pub fn session_count(&self) -> usize {
        self.lock_sessions().len()
    }

    /// Whether this manager owns `session_id`, so the command layer can route
    /// write/resize/disconnect to the right manager by ownership.
    pub fn owns(&self, session_id: &str) -> bool {
        self.lock_sessions().contains_key(session_id)
    }

    /// Clone out a session's control `Sender` (lock held only for the clone,
    /// never across the subsequent await).
    fn control_of(&self, session_id: &str) -> Option<mpsc::Sender<ShellControl>> {
        self.lock_sessions()
            .get(session_id)
            .map(|h| h.control.clone())
    }

    /// Spawn a live local shell session. Inserts the handle synchronously (so the
    /// map reflects the session the instant this returns) and drives the rest on
    /// a tokio task that removes its own entry on exit.
    pub fn spawn_session(
        self: &Arc<Self>,
        session_id: String,
        params: LocalShellParams,
        sink: Arc<dyn SessionSink>,
    ) {
        let (control_tx, control_rx) = mpsc::channel(CONTROL_CHANNEL_CAPACITY);
        self.lock_sessions().insert(
            session_id.clone(),
            ShellHandle {
                control: control_tx,
            },
        );

        let manager = Arc::clone(self);
        tokio::spawn(async move {
            sink.on_status(SessionStatus::Connecting, None);

            let result = run_session(params, Arc::clone(&sink), control_rx).await;
            match result {
                Ok(status) => sink.on_status(status, None),
                // AppError messages are always secret-free (local shells have none).
                Err(err) => sink.on_error(&err),
            }

            // Single owner of cleanup: the task removes its own entry for every
            // terminal reason (spawn fail, shell exit, error, disconnect).
            manager.lock_sessions().remove(&session_id);
        });
    }

    /// Send bytes to a session's shell. Unknown/closed session ⇒ ignored.
    pub async fn write_stdin(&self, session_id: &str, data: Vec<u8>) {
        if let Some(control) = self.control_of(session_id) {
            let _ = control.send(ShellControl::Write(data)).await;
        }
    }

    /// Resize a session's PTY. Unknown/closed session ⇒ ignored.
    pub async fn resize_pty(&self, session_id: &str, cols: u32, rows: u32) {
        if let Some(control) = self.control_of(session_id) {
            let _ = control
                .send(ShellControl::Resize {
                    cols: cols.min(u16::MAX as u32) as u16,
                    rows: rows.min(u16::MAX as u32) as u16,
                })
                .await;
        }
    }

    /// Request a graceful disconnect. Idempotent: an unknown `session_id` is a
    /// no-op. The task performs the actual map removal when it exits.
    pub async fn disconnect(&self, session_id: &str) {
        if let Some(control) = self.control_of(session_id) {
            let _ = control.send(ShellControl::Disconnect).await;
        }
    }

    /// Gracefully disconnect every live local shell session and wait (briefly)
    /// for the tasks to tear down, mirroring the SSH/serial managers so app close
    /// ends local shells cleanly too.
    pub async fn disconnect_all(&self) {
        let ids: Vec<String> = self.lock_sessions().keys().cloned().collect();
        for id in &ids {
            self.disconnect(id).await;
        }
        for _ in 0..50 {
            if self.session_count() == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// Test sink that records streamed bytes and status transitions.
    #[derive(Default)]
    struct RecordingSink {
        data: StdMutex<Vec<u8>>,
        statuses: StdMutex<Vec<SessionStatus>>,
    }

    impl RecordingSink {
        fn text(&self) -> String {
            String::from_utf8_lossy(&self.data.lock().unwrap()).into_owned()
        }
        fn statuses(&self) -> Vec<SessionStatus> {
            self.statuses.lock().unwrap().clone()
        }
    }

    impl SessionSink for RecordingSink {
        fn on_data(&self, bytes: &[u8]) {
            self.data.lock().unwrap().extend_from_slice(bytes);
        }
        fn on_status(&self, status: SessionStatus, _message: Option<String>) {
            self.statuses.lock().unwrap().push(status);
        }
        fn on_host_key_prompt(&self, _payload: crate::session::HostKeyPromptPayload) {
            unreachable!("local shell sessions never prompt for a host key");
        }
    }

    #[test]
    fn scrubs_only_the_tls_vars_absent_at_startup() {
        assert_eq!(vars_to_scrub(&[]), vec!["SSL_CERT_FILE", "SSL_CERT_DIR"]);
        assert_eq!(vars_to_scrub(&["SSL_CERT_FILE"]), vec!["SSL_CERT_DIR"]);
        assert!(vars_to_scrub(&["SSL_CERT_FILE", "SSL_CERT_DIR"]).is_empty());
    }

    /// The updater sets Debian paths when the vars are unset; presetting this
    /// system's real ones keeps it from touching the environment at all.
    #[test]
    fn missing_tls_vars_are_preset_to_the_first_existing_trust_store() {
        let fedora = |path: &str| path.starts_with("/etc/pki/tls/");
        assert_eq!(
            tls_presets(&["SSL_CERT_FILE", "SSL_CERT_DIR"], fedora),
            vec![
                ("SSL_CERT_FILE", "/etc/pki/tls/certs/ca-bundle.crt"),
                ("SSL_CERT_DIR", "/etc/pki/tls/certs"),
            ]
        );
        let debian = |path: &str| path.starts_with("/etc/ssl/certs");
        assert_eq!(
            tls_presets(&["SSL_CERT_DIR"], debian),
            vec![("SSL_CERT_DIR", "/etc/ssl/certs")]
        );
    }

    #[test]
    fn a_tls_var_without_a_trust_store_is_not_preset() {
        assert!(tls_presets(&["SSL_CERT_FILE", "SSL_CERT_DIR"], |_| false).is_empty());
    }

    /// After a check only what the updater itself set is removed: never a
    /// var the app started with or preset, never one that isn't set.
    #[test]
    fn only_the_vars_the_updater_set_are_removed_after_a_check() {
        let set_now = |var: &str| var == "SSL_CERT_FILE";
        assert_eq!(updater_set_vars(&[], &[], set_now), vec!["SSL_CERT_FILE"]);
        assert!(updater_set_vars(&[], &["SSL_CERT_FILE"], set_now).is_empty());
        assert!(updater_set_vars(&["SSL_CERT_FILE"], &[], set_now).is_empty());
        assert!(updater_set_vars(&[], &[], |_| false).is_empty());
    }

    #[test]
    fn scrub_removes_the_updater_tls_vars_from_the_shell_env() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.env("SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt");
        cmd.env("SSL_CERT_DIR", "/etc/ssl/certs");

        scrub_env(&mut cmd, &["SSL_CERT_DIR"]);

        assert!(cmd.get_env("SSL_CERT_FILE").is_some());
        assert!(cmd.get_env("SSL_CERT_DIR").is_none());
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

    #[test]
    fn a_fresh_manager_tracks_no_sessions() {
        let manager = LocalShellManager::new();
        assert_eq!(manager.session_count(), 0);
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
        let manager = Arc::new(LocalShellManager::new());
        let sink = Arc::new(RecordingSink::default());
        manager.spawn_session(
            "ls1".to_string(),
            LocalShellParams {
                shell: Some(shell),
                cwd: None,
                cols: 80,
                rows: 24,
                connect_snippet: None,
            },
            Arc::clone(&sink) as Arc<dyn SessionSink>,
        );

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
            manager
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

        manager.disconnect_all().await;
        assert_eq!(manager.session_count(), 0);
    }

    /// A background job still holding the PTY must not keep the reader thread
    /// (and with it the PTY) alive once the session ends. Disowned, so no shell
    /// hangs it up on exit: bash would, dash (`/bin/sh` on Ubuntu) never does.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_background_job_does_not_keep_the_reader_alive() {
        let manager = Arc::new(LocalShellManager::new());
        let sink = Arc::new(RecordingSink::default());
        manager.spawn_session(
            "ls1".to_string(),
            LocalShellParams {
                shell: Some("/bin/sh".to_string()),
                cwd: None,
                cols: 80,
                rows: 24,
                connect_snippet: None,
            },
            Arc::clone(&sink) as Arc<dyn SessionSink>,
        );
        manager
            .write_stdin("ls1", b"sleep 5 & disown; echo JOB_STARTED\n".to_vec())
            .await;
        for _ in 0..60 {
            if sink.text().contains("JOB_STARTED\r\n") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        manager.disconnect_all().await;

        // Only the test's own reference is left once every thread let go.
        for _ in 0..50 {
            if Arc::strong_count(&sink) == 1 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the reader thread outlived the session");
    }
}
