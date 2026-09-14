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
//! - a **reader thread** pumps PTY output into the sink until EOF;
//! - a **writer thread** drains an mpsc of keystroke chunks into the PTY;
//! - the **control task** (tokio) owns the master (for `resize`) and a child
//!   killer, applies control messages, and ends the session when the child exits
//!   (a blocking `wait` fires a `done` channel) or a disconnect is requested.
//!
//! There are **no secrets** here (like serial), and auto-reconnect does not apply
//! — a shell exiting is a normal end, surfaced as `Disconnected`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tokio::sync::mpsc;

use crate::error::AppError;
use crate::session::{SessionSink, SessionStatus};

/// Bound on the per-session control channel — same rationale as the SSH/serial
/// sessions': keeps it from being unbounded; keyboard-rate input never backs up.
const CONTROL_CHANNEL_CAPACITY: usize = 256;
/// Read buffer for the PTY→terminal pump. 4 KiB covers a burst of shell output
/// between reads without oversizing each copy (matches the serial pump).
const READ_BUFFER_SIZE: usize = 4096;

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
    reader: Box<dyn Read + Send>,
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

/// Build the `CommandBuilder` for the shell: the resolved program, the resolved
/// startup directory (when known), and `TERM=xterm-256color` so full-screen
/// programs behave (matching the SSH session's `TERM`).
fn build_command(params: &LocalShellParams) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(resolve_program(&params.shell));
    if let Some(dir) = resolve_cwd(&params.cwd) {
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");
    cmd
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

    let reader = pair
        .master
        .try_clone_reader()
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
/// and end when the shell exits or a disconnect is requested. Returns `Ok(())`
/// for any clean end and `Err` for a failure that should surface as
/// `session_status: error`.
async fn run_session(
    params: LocalShellParams,
    sink: Arc<dyn SessionSink>,
    mut control_rx: mpsc::Receiver<ShellControl>,
) -> Result<(), AppError> {
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

    // Reader thread: pump PTY output into the sink until EOF or a read error
    // (both mean the shell/PTY is gone). `sink` is `Send + Sync`, so it is called
    // directly from the thread.
    let reader_sink = Arc::clone(&sink);
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; READ_BUFFER_SIZE];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(count) => reader_sink.on_data(&buf[..count]),
            }
        }
    });

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

    // Detect the shell exiting on its own: a blocking `wait` fires `done`.
    let (done_tx, mut done_rx) = mpsc::channel::<()>(1);
    std::thread::spawn(move || {
        let _ = child.wait();
        let _ = done_tx.blocking_send(());
    });

    loop {
        tokio::select! {
            ctrl = control_rx.recv() => {
                match ctrl {
                    Some(ShellControl::Write(bytes)) => {
                        // Writer thread gone ⇒ PTY is dead; end the session.
                        if write_tx.send(bytes).is_err() {
                            break;
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
                    Some(ShellControl::Disconnect) | None => break,
                }
            }
            // The shell process exited: clean end.
            _ = done_rx.recv() => break,
        }
    }

    // Teardown: kill the child (idempotent if it already exited), end the writer
    // thread by dropping its sender, and drop the master so the PTY closes and
    // the reader thread returns.
    let _ = killer.kill();
    drop(write_tx);
    drop(master);
    Ok(())
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
                Ok(()) => sink.on_status(SessionStatus::Disconnected, None),
                // AppError messages are always secret-free (local shells have none).
                Err(err) => sink.on_status(SessionStatus::Error, Some(err.to_string())),
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
    fn resolve_cwd_prefers_explicit_dir() {
        assert_eq!(
            resolve_cwd(&Some("/tmp/work".to_string())),
            Some("/tmp/work".to_string())
        );
        // Blank ⇒ home or None, never the blank string.
        assert_ne!(resolve_cwd(&Some("  ".to_string())), Some("  ".to_string()));
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
}
