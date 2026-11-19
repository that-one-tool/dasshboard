//! Serial/COM Sessions: `spawn_session` runs one in the `SessionRegistry`
//! (`session_registry.rs`); it opens the port, reports Connected, and pumps
//! bytes both ways until EOF, an error or a disconnect; it keeps reading while
//! a write is stalled (flow control).
//!
//! ## Testability without hardware (the reviewer's focus)
//!
//! The byte pump [`run_pump`] is generic over any `AsyncRead + AsyncWrite`
//! stream, so tests drive it with an in-memory `tokio::io::duplex()` pair — no
//! COM port required. The only hardware-touching call, opening the port, is
//! isolated in [`open_port`]; the framing-param translation ([`to_builder`] and
//! the `to_*` helpers) is pure and unit-tested directly. No test opens a
//! physical port.

use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, watch};
use tokio_serial::SerialPortBuilderExt;

use crate::device::{FlowControl, Parity};
use crate::error::AppError;
use crate::session_registry::{NewSession, RunnerControls, SessionRegistry};
use crate::session_sink::{SessionSink, SessionStatus};

/// Read buffer for the port→terminal pump. 4 KiB covers a burst of serial
/// output between reads without oversizing each copy.
const READ_BUFFER_SIZE: usize = 4096;

/// The connection-shaped params for a serial session. Built by the `connect`
/// command from a `Connection::Serial` device.
pub struct SerialParams {
    pub port_name: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub parity: Parity,
    pub stop_bits: u8,
    pub flow_control: FlowControl,
    /// Optional commands to send once the port is open (the device's connect
    /// snippet). Sent verbatim (each line terminated with `\r`); `None` ⇒ nothing.
    pub connect_snippet: Option<String>,
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

/// Start a serial Session in `registry`.
pub fn spawn_session(registry: &Arc<SessionRegistry>, session: NewSession, params: SerialParams) {
    registry.spawn(session, |controls, sink| {
        run_session(params, sink, controls)
    });
}

/// The full lifecycle of one serial session: open the port (reporting Connected
/// on success), then pump until it ends. Any clean end is `Disconnected`; `Err`
/// is a failure that should surface as `session_status: error`. A serial line
/// has no window size, so resizes are ignored.
async fn run_session(
    params: SerialParams,
    sink: Arc<dyn SessionSink>,
    controls: RunnerControls,
) -> Result<SessionStatus, AppError> {
    let RunnerControls {
        input, mut stop, ..
    } = controls;
    let mut stream = open_port(&params)?;
    sink.on_status(SessionStatus::Connected, None);
    // Best-effort: a failed snippet neither hides Connected nor ends the session.
    if let Some(bytes) = crate::device::connect_snippet_bytes(params.connect_snippet.as_deref()) {
        write_until_stop(&mut stream, &bytes, &mut stop).await;
    }
    run_pump(stream, sink, input, stop).await?;
    Ok(SessionStatus::Disconnected)
}

/// Pump bytes both ways between the port and the sink until EOF, a disconnect,
/// a failed write or an I/O error. Generic over the stream so tests can
/// substitute an in-memory duplex pipe for a real `SerialStream`.
///
/// Reads and writes run side by side: under flow control a write waits for as
/// long as the device isn't ready, and the device's output must keep flowing
/// meanwhile. A disconnect cuts both short.
async fn run_pump<S>(
    stream: S,
    sink: Arc<dyn SessionSink>,
    input: mpsc::Receiver<Vec<u8>>,
    mut stop: watch::Receiver<bool>,
) -> Result<(), AppError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    let (reader, writer) = tokio::io::split(stream);
    tokio::select! {
        read = forward_output(reader, sink.as_ref()) => read,
        () = write_input(writer, input) => Ok(()),
        _ = stop.wait_for(|requested| *requested) => Ok(()),
    }
}

/// Port → sink until EOF (the port closed on the other end) or a read error.
async fn forward_output(
    mut reader: impl AsyncRead + Unpin,
    sink: &dyn SessionSink,
) -> Result<(), AppError> {
    let mut buf = [0u8; READ_BUFFER_SIZE];
    loop {
        let count = reader
            .read(&mut buf)
            .await
            .map_err(|e| AppError::Io(format!("serial read failed: {e}")))?;
        if count == 0 {
            return Ok(());
        }
        sink.on_data(&buf[..count]);
    }
}

/// Input → port until the input closes or a write fails; a failed write ends
/// the session cleanly (Disconnected), like a failed SSH `channel.data`.
async fn write_input(mut writer: impl AsyncWrite + Unpin, mut input: mpsc::Receiver<Vec<u8>>) {
    while let Some(bytes) = input.recv().await {
        if !write_bytes(&mut writer, &bytes).await {
            return;
        }
    }
}

/// [`write_bytes`], cut short by a disconnect.
async fn write_until_stop<S>(stream: &mut S, bytes: &[u8], stop: &mut watch::Receiver<bool>)
where
    S: AsyncWrite + Unpin,
{
    tokio::select! {
        _ = write_bytes(stream, bytes) => {}
        _ = stop.wait_for(|requested| *requested) => {}
    }
}

/// Whether the write went through.
async fn write_bytes(writer: &mut (impl AsyncWrite + Unpin), bytes: &[u8]) -> bool {
    if writer.write_all(bytes).await.is_err() {
        return false;
    }
    // Flush so keystrokes reach the device promptly rather than sitting in an
    // OS write buffer.
    let _ = writer.flush().await;
    true
}

/// Open + immediately close the port, no pump (the serial analogue of SSH
/// `test_connection`). There is no auth or host key, so success is simply
/// "the port opened". The stream is dropped at scope end, closing the port.
pub async fn test_connection(params: SerialParams) -> Result<(), AppError> {
    let _stream = open_port(&params)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_registry::open_channels;
    use crate::session_sink::testing::RecordingSink;
    use std::time::Duration;
    use tokio::io::duplex;

    fn serial_params() -> SerialParams {
        SerialParams {
            port_name: "COM-TEST".to_string(),
            baud_rate: 115200,
            data_bits: 8,
            parity: Parity::None,
            stop_bits: 1,
            flow_control: FlowControl::None,
            connect_snippet: None,
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
        let (_control_tx, control_rx) = mpsc::channel(4);
        let (stop_tx, stop_rx) = watch::channel(false);

        let sink_for_task = Arc::clone(&sink) as Arc<dyn SessionSink>;
        let pump = tokio::spawn(run_pump(port, sink_for_task, control_rx, stop_rx));

        // The "device" writes some bytes; they must reach the sink verbatim.
        peer.write_all(b"hello serial").await.unwrap();
        peer.flush().await.unwrap();

        // Give the pump a moment, then end it so the task returns.
        tokio::time::sleep(Duration::from_millis(20)).await;
        stop_tx.send_replace(true);
        pump.await.unwrap().unwrap();

        assert_eq!(sink.data(), b"hello serial");
    }

    #[tokio::test]
    async fn pump_writes_control_bytes_to_the_port() {
        let (port, mut peer) = duplex(64);
        let sink = Arc::new(RecordingSink::default()) as Arc<dyn SessionSink>;
        let (control_tx, control_rx) = mpsc::channel(4);
        let (stop_tx, stop_rx) = watch::channel(false);
        let pump = tokio::spawn(run_pump(port, sink, control_rx, stop_rx));

        control_tx.send(b"AT\r\n".to_vec()).await.unwrap();

        // The "device" reads exactly what was written.
        let mut got = [0u8; 4];
        peer.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"AT\r\n");

        stop_tx.send_replace(true);
        pump.await.unwrap().unwrap();
    }

    /// Under flow control a write can wait as long as the device isn't ready;
    /// the device's output must keep reaching the terminal meanwhile.
    #[tokio::test]
    async fn pump_keeps_reading_during_a_stalled_write() {
        let (port, mut peer) = duplex(4);
        let sink = Arc::new(RecordingSink::default());
        let (control_tx, control_rx) = mpsc::channel(4);
        let (stop_tx, stop_rx) = watch::channel(false);
        let sink_for_task = Arc::clone(&sink) as Arc<dyn SessionSink>;
        let pump = tokio::spawn(run_pump(port, sink_for_task, control_rx, stop_rx));
        control_tx.send(vec![b'x'; 64]).await.unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;

        peer.write_all(b"hi").await.unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;

        assert_eq!(sink.data(), b"hi");
        stop_tx.send_replace(true);
        pump.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn pump_ends_when_a_write_fails() {
        let (port, peer) = duplex(64);
        let sink = Arc::new(RecordingSink::default()) as Arc<dyn SessionSink>;
        let (control_tx, control_rx) = mpsc::channel(4);
        let (_stop_tx, stop_rx) = watch::channel(false);
        let pump = tokio::spawn(run_pump(port, sink, control_rx, stop_rx));
        drop(peer);

        let _ = control_tx.send(b"x".to_vec()).await;

        pump.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn pump_stops_on_disconnect() {
        let (port, _peer) = duplex(64);
        let sink = Arc::new(RecordingSink::default()) as Arc<dyn SessionSink>;
        let (_control_tx, control_rx) = mpsc::channel(4);
        let (stop_tx, stop_rx) = watch::channel(false);
        let pump = tokio::spawn(run_pump(port, sink, control_rx, stop_rx));

        stop_tx.send_replace(true);
        // A clean disconnect resolves the pump to Ok(()).
        pump.await.unwrap().unwrap();
    }

    /// B3: under flow control a write can wait forever on a device that never
    /// signals ready; a disconnect must still end the session.
    #[tokio::test]
    async fn pump_stops_on_disconnect_during_a_stalled_write() {
        // The peer never reads, so a write larger than the pipe never finishes.
        let (port, _peer) = duplex(4);
        let sink = Arc::new(RecordingSink::default()) as Arc<dyn SessionSink>;
        let (control_tx, control_rx) = mpsc::channel(4);
        let (stop_tx, stop_rx) = watch::channel(false);
        let pump = tokio::spawn(run_pump(port, sink, control_rx, stop_rx));
        control_tx.send(vec![b'x'; 64]).await.unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;

        stop_tx.send_replace(true);

        tokio::time::timeout(Duration::from_secs(1), pump)
            .await
            .expect("the pump must stop despite the stalled write")
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn pump_stops_on_eof_when_port_closes() {
        let (port, peer) = duplex(64);
        let sink = Arc::new(RecordingSink::default()) as Arc<dyn SessionSink>;
        let (_control_tx, control_rx) = mpsc::channel(4);
        let (_stop_tx, stop_rx) = watch::channel(false);
        let pump = tokio::spawn(run_pump(port, sink, control_rx, stop_rx));

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
        let (_handle, controls) = open_channels();
        let sink_for_run = Arc::clone(&sink) as Arc<dyn SessionSink>;
        let result = run_session(params, sink_for_run, controls).await;

        assert!(result.is_err(), "opening a missing port must fail");
        assert!(
            !sink.statuses().contains(&SessionStatus::Connected),
            "must not report Connected when the port never opened"
        );
    }

    #[tokio::test]
    async fn test_connection_errors_on_a_missing_port() {
        let params = SerialParams {
            port_name: "___no_such_serial_port___".to_string(),
            ..serial_params()
        };
        assert!(test_connection(params).await.is_err());
    }
}
