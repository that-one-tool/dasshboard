//! Terminal sessions (SSH, serial, local shell): connect, output, input,
//! resize, disconnect, and the no-shell connection test.

use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager, State};

use super::client_ids::{client_chosen_id, id_in_use};
use super::device_access::{find_device, keepalive_config, resolve_credentials, resolve_jump_hop};
use super::host_keys::{emit_host_key_prompt_closed, HOST_KEY_PROMPT_EVENT};
use crate::device::{Connection, Device};
use crate::error::AppError;
use crate::local_shell::LocalShellParams;
use crate::output_stream::{Chunk, OutputStream, OutputStreams, MAX_READ, READ_WAIT};
use crate::serial::SerialParams;
use crate::session::ConnectParams;
use crate::session_sink::{SessionSink, SessionStatus};
use crate::ssh::prompts::{HostKeyPromptPayload, HostKeyPrompter};
use crate::state::AppState;

const SESSION_STATUS_EVENT: &str = "session_status";

/// Wire payload of the `session_status` event (SPEC.md §5), `camelCase`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionStatusPayload {
    session_id: String,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    /// The `AppError` code of an `error` status (absent otherwise).
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'static str>,
}

/// How long a finished session's unread output waits for the frontend to read
/// it (a pane closed meanwhile never will).
const ENDED_OUTPUT_GRACE: std::time::Duration = std::time::Duration::from_secs(60);

/// Production [`SessionSink`]: keeps terminal bytes for the frontend to read
/// (`read_output`) and emits `session_status` / `host_key_prompt` Tauri events.
/// It carries only the session id and non-secret payloads — never a credential.
struct TauriSessionSink {
    app: AppHandle,
    session_id: String,
    /// `Some` for a live session; `None` for `test_connection`, which has no
    /// shell and streams no data.
    output: Option<Arc<OutputStream>>,
}

impl TauriSessionSink {
    /// The session is over: mark its output ended, and let it go once the
    /// frontend had time to read the rest.
    fn end_output(&self) {
        let Some(output) = &self.output else { return };
        output.close();
        let (app, id, output) = (
            self.app.clone(),
            self.session_id.clone(),
            Arc::clone(output),
        );
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(ENDED_OUTPUT_GRACE).await;
            app.state::<OutputStreams>().remove(&id, &output);
        });
    }
}

impl TauriSessionSink {
    fn emit_status(
        &self,
        status: SessionStatus,
        message: Option<String>,
        code: Option<&'static str>,
    ) {
        let _ = self.app.emit(
            SESSION_STATUS_EVENT,
            SessionStatusPayload {
                session_id: self.session_id.clone(),
                status: status.as_str(),
                message,
                code,
            },
        );
    }
}

impl SessionSink for TauriSessionSink {
    fn on_data(&self, bytes: &[u8]) {
        // Verbatim server output (SPEC §3), until the frontend reads it.
        if let Some(output) = &self.output {
            output.push(bytes);
        }
    }

    fn on_status(&self, status: SessionStatus, message: Option<String>) {
        if status.is_final() {
            self.end_output();
        }
        self.emit_status(status, message, None);
    }

    fn on_error(&self, err: &AppError) {
        self.end_output();
        self.emit_status(
            SessionStatus::Error,
            Some(err.to_string()),
            Some(err.code()),
        );
    }
}

impl HostKeyPrompter for TauriSessionSink {
    fn on_host_key_prompt(&self, payload: HostKeyPromptPayload) {
        let _ = self.app.emit(HOST_KEY_PROMPT_EVENT, payload);
    }
    fn on_host_key_prompt_closed(&self, prompt_id: &str) {
        emit_host_key_prompt_closed(&self.app, prompt_id);
    }
}

/// The output of session `id` after offset `from` (see `output_stream.rs`).
/// An unknown session reads as ended; reading a session's end lets its output
/// go.
async fn read_session_output(streams: &OutputStreams, id: &str, from: u64) -> Chunk {
    let Some(stream) = streams.get(id) else {
        return Chunk {
            start: from,
            bytes: Vec::new(),
            end: true,
        };
    };
    let chunk = stream.read(from, MAX_READ, READ_WAIT).await;
    if chunk.end {
        streams.remove(id, &stream);
    }
    chunk
}

/// A session's next output after offset `from`, waiting a while for some
/// (SPEC §3). Binary: `start` (u64, big-endian), an end flag byte, the bytes.
#[tauri::command]
pub async fn read_output(
    streams: State<'_, OutputStreams>,
    session_id: String,
    from: u64,
) -> Result<Response, AppError> {
    let chunk = read_session_output(&streams, &session_id, from).await;
    Ok(Response::new(chunk.encode()))
}

/// Open a live shell session (SPEC §5). Returns the new `sessionId`; the shell
/// itself is driven on a background task, its output read with `read_output`
/// and its lifecycle reported as `session_status`. Async so the command runs on
/// Tauri's tokio runtime, which `spawn_session`'s `tokio::spawn` needs.
#[tauri::command]
pub async fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    streams: State<'_, OutputStreams>,
    session_id: String,
    device_id: String,
    cols: u32,
    rows: u32,
) -> Result<String, AppError> {
    let session_id = client_chosen_id(session_id, |id| {
        id_in_use(&state, id) || streams.contains(id)
    })?;
    let device = find_device(&state, &device_id)?;
    // Open before the session starts, so its first bytes have somewhere to go.
    let output = streams.open(&session_id);
    let sink: Arc<dyn SessionSink> = Arc::new(TauriSessionSink {
        app,
        session_id: session_id.clone(),
        output: Some(Arc::clone(&output)),
    });
    let spawned = spawn_device_session(&state, &session_id, &device, (cols, rows), sink).await;
    if spawned.is_err() {
        streams.remove(&session_id, &output);
    }
    spawned.map(|()| session_id)
}

/// Start `device`'s session under `session_id`, reporting to `sink`.
async fn spawn_device_session(
    state: &AppState,
    session_id: &str,
    device: &Device,
    (cols, rows): (u32, u32),
    sink: Arc<dyn SessionSink>,
) -> Result<(), AppError> {
    let session_id = session_id.to_string();
    match &device.connection {
        Connection::Ssh {
            host,
            port,
            username,
            ..
        } => {
            let creds = resolve_credentials(state, device).await?;
            // Resolve the optional jump host (ProxyJump) up front, so a
            // misconfigured jump surfaces as a connect error rather than a
            // half-open session.
            let jump = resolve_jump_hop(state, device).await?;
            state.session_manager.spawn_session(
                session_id,
                ConnectParams {
                    host: host.clone(),
                    port: *port,
                    username: username.clone(),
                    creds,
                    cols,
                    rows,
                    jump,
                    keepalive: keepalive_config(state),
                    forward_agent: device.forward_agent_enabled(),
                    connect_snippet: device.connect_snippet().map(str::to_string),
                },
                sink,
            );
        }
        Connection::Serial { .. } => {
            state.serial_manager.spawn_session(
                session_id,
                serial_params_of(&device.connection, device.connect_snippet()),
                sink,
            );
        }
        Connection::LocalShell { shell, cwd } => {
            state.local_shell_manager.spawn_session(
                session_id,
                LocalShellParams {
                    shell: shell.clone(),
                    cwd: cwd.clone(),
                    cols: cols.min(u16::MAX as u32) as u16,
                    rows: rows.min(u16::MAX as u32) as u16,
                    connect_snippet: device.connect_snippet().map(str::to_string),
                },
                sink,
            );
        }
    }
    Ok(())
}

/// Build [`SerialParams`] from a `Connection::Serial`. A defensive `expect`
/// covers the impossible SSH case — callers only reach this on the serial
/// branch of a `match`.
fn serial_params_of(connection: &Connection, connect_snippet: Option<&str>) -> SerialParams {
    match connection {
        Connection::Serial {
            port_name,
            baud_rate,
            data_bits,
            parity,
            stop_bits,
            flow_control,
        } => SerialParams {
            port_name: port_name.clone(),
            baud_rate: *baud_rate,
            data_bits: *data_bits,
            parity: *parity,
            stop_bits: *stop_bits,
            flow_control: *flow_control,
            connect_snippet: connect_snippet.map(str::to_string),
        },
        _ => unreachable!("serial_params_of called on a non-serial connection"),
    }
}

/// Forward keystrokes to a session (SPEC §5). Unknown/closed session ⇒ no-op.
/// `binary` marks xterm's binary input (see [`stdin_bytes`]).
#[tauri::command]
pub async fn write_stdin(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
    binary: Option<bool>,
) -> Result<(), AppError> {
    let bytes = stdin_bytes(data, binary.unwrap_or(false));
    // Route to whichever manager owns the session. `owns` locks+releases the
    // map synchronously (no guard held across the `.await`); the `Arc` is cloned
    // out before awaiting. An unknown id is a no-op in either manager.
    if state.session_manager.owns(&session_id) {
        Arc::clone(&state.session_manager)
            .write_stdin(&session_id, bytes)
            .await;
    } else if state.local_shell_manager.owns(&session_id) {
        Arc::clone(&state.local_shell_manager)
            .write_stdin(&session_id, bytes)
            .await;
    } else {
        Arc::clone(&state.serial_manager)
            .write_stdin(&session_id, bytes)
            .await;
    }
    Ok(())
}

/// The bytes to send for terminal input: text as UTF-8, binary input (legacy
/// mouse reports, which aren't UTF-8) as one byte per character — xterm never
/// puts a character above U+00FF there.
fn stdin_bytes(data: String, binary: bool) -> Vec<u8> {
    if !binary {
        return data.into_bytes();
    }
    data.chars()
        .filter_map(|c| u8::try_from(u32::from(c)).ok())
        .collect()
}

/// Resize a session's terminal (SPEC §5). Unknown/closed session ⇒ no-op. A
/// serial session has no window size, so its resize is a no-op.
#[tauri::command]
pub async fn resize_pty(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), AppError> {
    if state.session_manager.owns(&session_id) {
        Arc::clone(&state.session_manager)
            .resize_pty(&session_id, cols, rows)
            .await;
    } else if state.local_shell_manager.owns(&session_id) {
        state
            .local_shell_manager
            .resize_pty(&session_id, cols, rows)
            .await;
    } else {
        state.serial_manager.resize_pty(&session_id, cols, rows);
    }
    Ok(())
}

/// Gracefully disconnect a session (SPEC §5). Idempotent: an unknown
/// `sessionId` is a no-op. Routes to whichever manager owns it.
#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, session_id: String) -> Result<(), AppError> {
    if state.session_manager.owns(&session_id) {
        Arc::clone(&state.session_manager)
            .disconnect(&session_id)
            .await;
    } else if state.local_shell_manager.owns(&session_id) {
        Arc::clone(&state.local_shell_manager)
            .disconnect(&session_id)
            .await;
    } else {
        Arc::clone(&state.serial_manager)
            .disconnect(&session_id)
            .await;
    }
    Ok(())
}

/// Connect + authenticate + close, no shell (SPEC §5). Surfaces the auth
/// outcome as `Ok(())` / `Err(AppError)`. Shares the host-key path, so a
/// first-contact test can raise a `host_key_prompt` like a live connect.
#[tauri::command]
pub async fn test_connection(
    app: AppHandle,
    state: State<'_, AppState>,
    device_id: String,
) -> Result<(), AppError> {
    let device = find_device(&state, &device_id)?;
    match &device.connection {
        Connection::Ssh {
            host,
            port,
            username,
            ..
        } => {
            let creds = resolve_credentials(&state, &device).await?;
            let jump = resolve_jump_hop(&state, &device).await?;
            let manager = Arc::clone(&state.session_manager);
            let sink: Arc<dyn SessionSink> = Arc::new(TauriSessionSink {
                app,
                session_id: format!("test-{device_id}"),
                output: None,
            });
            manager
                .test_connection(host.clone(), *port, username.clone(), creds, jump, sink)
                .await
        }
        // Serial has no auth or host key: "connected" simply means the port
        // opened. No sink is needed (nothing streams).
        Connection::Serial { .. } => {
            state
                .serial_manager
                .test_connection(serial_params_of(&device.connection, None))
                .await
        }
        // A local shell has nothing to test ahead of time — it either spawns at
        // connect time or reports an error then. Treat "test" as always OK.
        Connection::LocalShell { .. } => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_input_is_sent_as_utf8() {
        assert_eq!(stdin_bytes("é\r".into(), false), "é\r".as_bytes());
    }

    /// xterm's binary input (legacy mouse reports) is one byte per character.
    #[test]
    fn binary_input_is_sent_one_byte_per_character() {
        assert_eq!(
            stdin_bytes("\x1b[M \u{ff}!".into(), true),
            [0x1b, b'[', b'M', b' ', 0xff, b'!']
        );
    }

    #[test]
    fn session_status_payload_carries_the_error_code_only_when_set() {
        let payload = |code| SessionStatusPayload {
            session_id: "s1".to_string(),
            status: "error",
            message: Some("authentication failed".to_string()),
            code,
        };
        let with_code = serde_json::to_value(payload(Some("SshAuth"))).unwrap();
        assert_eq!(with_code["code"], "SshAuth");
        assert_eq!(with_code["sessionId"], "s1");
        let without = serde_json::to_value(payload(None)).unwrap();
        assert!(without.get("code").is_none());
    }

    #[tokio::test]
    async fn reading_an_unknown_session_reports_its_end() {
        let streams = OutputStreams::default();
        let chunk = read_session_output(&streams, "gone", 42).await;
        assert!(chunk.end);
        assert_eq!(chunk.start, 42);
    }

    #[tokio::test]
    async fn reading_a_session_to_its_end_lets_its_output_go() {
        let streams = OutputStreams::default();
        let stream = streams.open("s1");
        stream.push(b"bye");
        stream.close();

        assert_eq!(read_session_output(&streams, "s1", 0).await.bytes, b"bye");
        assert!(streams.contains("s1"), "kept until read to the end");
        assert!(read_session_output(&streams, "s1", 3).await.end);
        assert!(!streams.contains("s1"));
    }
}
