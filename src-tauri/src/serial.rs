//! Serial/COM session core — the serial analogue of `session.rs`'s
//! `SessionManager`. It **reuses** the Tauri-free [`SessionSink`] +
//! [`SessionStatus`] seam (no parallel event system): a serial session emits
//! Connecting → Connected → Disconnected/Error over the same sink an SSH
//! session does, so the frontend pane treats both identically.
//!
//! ## Locking & anti-deadlock design (mirrors `SessionManager`)
//!
//! - The session map is a plain `std::sync::Mutex<HashMap<..>>`, locked only to
//!   insert/remove/clone-out an mpsc `Sender`; the guard is **never held across
//!   an `.await`**.
//! - One `tokio` task per session; the task removes its own map entry on exit,
//!   for every terminal reason (open failure, EOF, read/write error,
//!   disconnect). Cleanup has a single owner.
//!
//! ## Testability without hardware (the reviewer's focus)
//!
//! The byte pump [`run_pump`] is generic over any `AsyncRead + AsyncWrite`
//! stream, so tests drive it with an in-memory `tokio::io::duplex()` pair — no
//! COM port required. The only hardware-touching call, opening the port, is
//! isolated in [`open_port`]; the framing-param translation ([`to_builder`] and
//! the `to_*` helpers) is pure and unit-tested directly. No test opens a
//! physical port.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio_serial::SerialPortBuilderExt;

use crate::device::{FlowControl, Parity};
use crate::error::AppError;
use crate::session::{SessionSink, SessionStatus};

/// Bound on the per-session control channel — same rationale as the SSH
/// session's: keeps it from being unbounded; keyboard-rate input never
/// realistically backs it up.
const CONTROL_CHANNEL_CAPACITY: usize = 256;
/// Read buffer for the port→terminal pump. 4 KiB covers a burst of serial
/// output between reads without oversizing each copy.
const READ_BUFFER_SIZE: usize = 4096;

/// The connection-shaped params for a serial session (mirrors
/// `session::ConnectParams`). Built by the `connect` command from a
/// `Connection::Serial` device.
pub struct SerialParams {
    pub port_name: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub parity: Parity,
    pub stop_bits: u8,
    pub flow_control: FlowControl,
}

/// Control messages to a serial session task. There is no resize: a serial line
/// has no window size, so the manager's `resize_pty` is a no-op that sends
/// nothing.
enum SerialControl {
    Write(Vec<u8>),
    Disconnect,
}

/// Per-session handle: just the control `Sender`. Dropping every clone (the
/// manager forgetting the session) makes the task's `recv()` return `None`,
/// which it treats as a disconnect.
struct SerialHandle {
    control: mpsc::Sender<SerialControl>,
}

/// Map our framing params onto a `tokio_serial` port builder. Pure (no I/O);
/// unit-tested directly so the translation is covered without a port.
fn to_builder(params: &SerialParams) -> tokio_serial::SerialPortBuilder {
    tokio_serial::new(&params.port_name, params.baud_rate)
        .data_bits(to_data_bits(params.data_bits))
        .parity(to_parity(params.parity))
        .stop_bits(to_stop_bits(params.stop_bits))
        .flow_control(to_flow_control(params.flow_control))
}

/// Non-8 data-bit counts map to their `tokio_serial` variant; anything else
/// (including the 8 default) is 8 — the common case.
fn to_data_bits(bits: u8) -> tokio_serial::DataBits {
    match bits {
        5 => tokio_serial::DataBits::Five,
        6 => tokio_serial::DataBits::Six,
        7 => tokio_serial::DataBits::Seven,
        _ => tokio_serial::DataBits::Eight,
    }
}

/// Only 1 and 2 stop bits exist; anything but 2 is treated as the 1 default.
fn to_stop_bits(bits: u8) -> tokio_serial::StopBits {
    match bits {
        2 => tokio_serial::StopBits::Two,
        _ => tokio_serial::StopBits::One,
    }
}

fn to_parity(parity: Parity) -> tokio_serial::Parity {
    match parity {
        Parity::None => tokio_serial::Parity::None,
        Parity::Odd => tokio_serial::Parity::Odd,
        Parity::Even => tokio_serial::Parity::Even,
    }
}

fn to_flow_control(flow: FlowControl) -> tokio_serial::FlowControl {
    match flow {
        FlowControl::None => tokio_serial::FlowControl::None,
        FlowControl::Software => tokio_serial::FlowControl::Software,
        FlowControl::Hardware => tokio_serial::FlowControl::Hardware,
    }
}

/// Open the real serial port — the only hardware-touching call, isolated so the
/// pump stays unit-testable. A failure is an `Io` error (opening a port is an
/// I/O operation; the fixed `AppError` taxonomy has no serial-specific code).
/// The message names the port but carries nothing secret (serial has no
/// secrets).
fn open_port(params: &SerialParams) -> Result<tokio_serial::SerialStream, AppError> {
    to_builder(params).open_native_async().map_err(|e| {
        AppError::Io(format!(
            "could not open serial port {}: {e}",
            params.port_name
        ))
    })
}

/// Pump bytes both ways between the port and the sink until EOF, a disconnect,
/// or an I/O error. Generic over the stream so tests can substitute an
/// in-memory duplex pipe for a real `SerialStream`.
async fn run_pump<S>(
    mut stream: S,
    sink: Arc<dyn SessionSink>,
    mut control_rx: mpsc::Receiver<SerialControl>,
) -> Result<(), AppError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    let mut buf = [0u8; READ_BUFFER_SIZE];
    loop {
        tokio::select! {
            read = stream.read(&mut buf) => {
                let count = read.map_err(|e| AppError::Io(format!("serial read failed: {e}")))?;
                if count == 0 {
                    break; // EOF — the port was closed on the other end.
                }
                sink.on_data(&buf[..count]);
            }
            ctrl = control_rx.recv() => {
                if !apply_control(ctrl, &mut stream).await {
                    break;
                }
            }
        }
    }
    Ok(())
}

/// Apply one control message. Returns whether the pump loop should keep running.
/// A write failure ends the session cleanly (Disconnected), mirroring the SSH
/// path's treatment of a failed `channel.data`; an explicit disconnect (or the
/// manager dropping the handle, `None`) also stops it.
async fn apply_control<S>(ctrl: Option<SerialControl>, stream: &mut S) -> bool
where
    S: AsyncWrite + Unpin,
{
    match ctrl {
        Some(SerialControl::Write(bytes)) => {
            if stream.write_all(&bytes).await.is_err() {
                return false;
            }
            // Flush so keystrokes reach the device promptly rather than sitting
            // in an OS write buffer.
            let _ = stream.flush().await;
            true
        }
        Some(SerialControl::Disconnect) | None => false,
    }
}

/// The full lifecycle of one serial session: open the port (reporting Connected
/// on success), then pump until it ends. Returns `Ok(())` for any clean end and
/// `Err` for a failure that should surface as `session_status: error`.
async fn run_session(
    params: SerialParams,
    sink: Arc<dyn SessionSink>,
    control_rx: mpsc::Receiver<SerialControl>,
) -> Result<(), AppError> {
    let stream = open_port(&params)?;
    sink.on_status(SessionStatus::Connected, None);
    run_pump(stream, sink, control_rx).await
}

/// Owns all live serial sessions. Lives in Tauri managed state behind an `Arc`
/// (see `AppState`), alongside the SSH `SessionManager`.
pub struct SerialSessionManager {
    sessions: Mutex<HashMap<String, SerialHandle>>,
}

impl Default for SerialSessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SerialSessionManager {
    pub fn new() -> Self {
        SerialSessionManager {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    fn lock_sessions(&self) -> std::sync::MutexGuard<'_, HashMap<String, SerialHandle>> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Number of live serial sessions. Used by the app-close handler alongside
    /// the SSH count to decide whether a graceful teardown is needed.
    pub fn session_count(&self) -> usize {
        self.lock_sessions().len()
    }

    /// Clone out a session's control `Sender` (lock held only for the clone,
    /// never across the subsequent await).
    fn control_of(&self, session_id: &str) -> Option<mpsc::Sender<SerialControl>> {
        self.lock_sessions()
            .get(session_id)
            .map(|h| h.control.clone())
    }

    /// Spawn a live serial session. Inserts the handle synchronously (so the map
    /// reflects the session the instant this returns) and drives the rest on a
    /// tokio task that removes its own entry on exit.
    pub fn spawn_session(
        self: &Arc<Self>,
        session_id: String,
        params: SerialParams,
        sink: Arc<dyn SessionSink>,
    ) {
        let (control_tx, control_rx) = mpsc::channel(CONTROL_CHANNEL_CAPACITY);
        self.lock_sessions().insert(
            session_id.clone(),
            SerialHandle {
                control: control_tx,
            },
        );

        let manager = Arc::clone(self);
        tokio::spawn(async move {
            sink.on_status(SessionStatus::Connecting, None);

            let result = run_session(params, Arc::clone(&sink), control_rx).await;
            match result {
                Ok(()) => sink.on_status(SessionStatus::Disconnected, None),
                // AppError messages are always secret-free (serial has none).
                Err(err) => sink.on_status(SessionStatus::Error, Some(err.to_string())),
            }

            // Single owner of cleanup: the task removes its own entry for every
            // terminal reason (open fail, EOF, error, disconnect).
            manager.lock_sessions().remove(&session_id);
        });
    }

    /// Send bytes to a session's port. Unknown/closed session ⇒ ignored.
    pub async fn write_stdin(&self, session_id: &str, data: Vec<u8>) {
        if let Some(control) = self.control_of(session_id) {
            let _ = control.send(SerialControl::Write(data)).await;
        }
    }

    /// Resize is meaningless for a serial line (no window size) — a no-op,
    /// present so the command layer can route uniformly.
    pub fn resize_pty(&self, _session_id: &str, _cols: u32, _rows: u32) {}

    /// Request a graceful disconnect. Idempotent: an unknown `session_id` is a
    /// no-op. The task performs the actual map removal when it exits.
    pub async fn disconnect(&self, session_id: &str) {
        if let Some(control) = self.control_of(session_id) {
            let _ = control.send(SerialControl::Disconnect).await;
        }
    }

    /// Gracefully disconnect every live serial session and wait (briefly) for
    /// the tasks to tear down, mirroring `SessionManager::disconnect_all` so app
    /// close ends serial sessions cleanly too.
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

    /// Open + immediately close the port, no pump (the serial analogue of SSH
    /// `test_connection`). There is no auth or host key, so success is simply
    /// "the port opened". The stream is dropped at scope end, closing the port.
    pub async fn test_connection(&self, params: SerialParams) -> Result<(), AppError> {
        let _stream = open_port(&params)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use tokio::io::duplex;

    /// Test sink that records streamed bytes and status transitions. Mirrors the
    /// role of the SSH stack's test sink but is local to the serial tests.
    #[derive(Default)]
    struct RecordingSink {
        data: StdMutex<Vec<u8>>,
        statuses: StdMutex<Vec<SessionStatus>>,
    }

    impl RecordingSink {
        fn data(&self) -> Vec<u8> {
            self.data.lock().unwrap().clone()
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
            unreachable!("serial sessions never prompt for a host key");
        }
    }

    fn serial_params() -> SerialParams {
        SerialParams {
            port_name: "COM-TEST".to_string(),
            baud_rate: 115200,
            data_bits: 8,
            parity: Parity::None,
            stop_bits: 1,
            flow_control: FlowControl::None,
        }
    }

    #[test]
    fn framing_params_map_to_tokio_serial_types() {
        assert_eq!(to_data_bits(5), tokio_serial::DataBits::Five);
        assert_eq!(to_data_bits(7), tokio_serial::DataBits::Seven);
        assert_eq!(to_data_bits(8), tokio_serial::DataBits::Eight);
        // Anything unexpected falls back to the 8-bit default.
        assert_eq!(to_data_bits(99), tokio_serial::DataBits::Eight);

        assert_eq!(to_stop_bits(1), tokio_serial::StopBits::One);
        assert_eq!(to_stop_bits(2), tokio_serial::StopBits::Two);

        assert_eq!(to_parity(Parity::None), tokio_serial::Parity::None);
        assert_eq!(to_parity(Parity::Odd), tokio_serial::Parity::Odd);
        assert_eq!(to_parity(Parity::Even), tokio_serial::Parity::Even);

        assert_eq!(
            to_flow_control(FlowControl::None),
            tokio_serial::FlowControl::None
        );
        assert_eq!(
            to_flow_control(FlowControl::Software),
            tokio_serial::FlowControl::Software
        );
        assert_eq!(
            to_flow_control(FlowControl::Hardware),
            tokio_serial::FlowControl::Hardware
        );
    }

    #[test]
    fn builder_carries_port_name_and_baud() {
        // The builder is opaque, but `Debug` exposes the configured values —
        // enough to prove the params reached it without opening a port.
        let debug = format!("{:?}", to_builder(&serial_params()));
        assert!(debug.contains("COM-TEST"));
        assert!(debug.contains("115200"));
    }

    #[tokio::test]
    async fn pump_forwards_port_bytes_to_the_sink() {
        let (port, mut peer) = duplex(64);
        let sink = Arc::new(RecordingSink::default());
        let (control_tx, control_rx) = mpsc::channel(4);

        let sink_for_task = Arc::clone(&sink) as Arc<dyn SessionSink>;
        let pump = tokio::spawn(run_pump(port, sink_for_task, control_rx));

        // The "device" writes some bytes; they must reach the sink verbatim.
        peer.write_all(b"hello serial").await.unwrap();
        peer.flush().await.unwrap();

        // Give the pump a moment, then end it so the task returns.
        tokio::time::sleep(Duration::from_millis(20)).await;
        control_tx.send(SerialControl::Disconnect).await.unwrap();
        pump.await.unwrap().unwrap();

        assert_eq!(sink.data(), b"hello serial");
    }

    #[tokio::test]
    async fn pump_writes_control_bytes_to_the_port() {
        let (port, mut peer) = duplex(64);
        let sink = Arc::new(RecordingSink::default()) as Arc<dyn SessionSink>;
        let (control_tx, control_rx) = mpsc::channel(4);
        let pump = tokio::spawn(run_pump(port, sink, control_rx));

        control_tx
            .send(SerialControl::Write(b"AT\r\n".to_vec()))
            .await
            .unwrap();

        // The "device" reads exactly what was written.
        let mut got = [0u8; 4];
        peer.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"AT\r\n");

        control_tx.send(SerialControl::Disconnect).await.unwrap();
        pump.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn pump_stops_on_disconnect() {
        let (port, _peer) = duplex(64);
        let sink = Arc::new(RecordingSink::default()) as Arc<dyn SessionSink>;
        let (control_tx, control_rx) = mpsc::channel(4);
        let pump = tokio::spawn(run_pump(port, sink, control_rx));

        control_tx.send(SerialControl::Disconnect).await.unwrap();
        // A clean disconnect resolves the pump to Ok(()).
        pump.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn pump_stops_on_eof_when_port_closes() {
        let (port, peer) = duplex(64);
        let sink = Arc::new(RecordingSink::default()) as Arc<dyn SessionSink>;
        let (_control_tx, control_rx) = mpsc::channel(4);
        let pump = tokio::spawn(run_pump(port, sink, control_rx));

        // Closing the peer end yields a 0-byte read → clean EOF stop.
        drop(peer);
        pump.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn run_session_reports_error_when_the_port_cannot_open() {
        // A port name that does not exist fails to open on any platform, with no
        // hardware involved — so `run_session` returns Err (→ Error status) and
        // never emits Connected.
        let params = SerialParams {
            port_name: "___no_such_serial_port___".to_string(),
            ..serial_params()
        };
        let sink = Arc::new(RecordingSink::default());
        let (_tx, rx) = mpsc::channel(4);
        let result = run_session(params, Arc::clone(&sink) as Arc<dyn SessionSink>, rx).await;

        assert!(result.is_err(), "opening a missing port must fail");
        assert!(
            !sink.statuses().contains(&SessionStatus::Connected),
            "must not report Connected when the port never opened"
        );
    }

    #[tokio::test]
    async fn test_connection_errors_on_a_missing_port() {
        let manager = SerialSessionManager::new();
        let params = SerialParams {
            port_name: "___no_such_serial_port___".to_string(),
            ..serial_params()
        };
        assert!(manager.test_connection(params).await.is_err());
    }

    #[test]
    fn a_fresh_manager_tracks_no_sessions() {
        // Nothing is live until a session is spawned — the command layer routes
        // any id this manager does not track back to the SSH manager.
        let manager = SerialSessionManager::new();
        assert_eq!(manager.session_count(), 0);
    }
}
