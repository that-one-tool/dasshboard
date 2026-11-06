//! Recording a session's output to a file: start, stop, and the
//! `recording_failed` event when a recording stops on its own.

use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::error::AppError;
use crate::session_recording::Recorders;

const RECORDING_FAILED_EVENT: &str = "recording_failed";

/// Wire payload of the `recording_failed` event, `camelCase`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingFailedPayload {
    session_id: String,
    message: String,
}

/// A recording of session `session_id` stopped on `err` (a failed write).
pub(crate) fn emit_recording_failed(app: &AppHandle, session_id: &str, err: &AppError) {
    let _ = app.emit(RECORDING_FAILED_EVENT, failed_payload(session_id, err));
}

fn failed_payload(session_id: &str, err: &AppError) -> RecordingFailedPayload {
    RecordingFailedPayload {
        session_id: session_id.to_string(),
        message: err.to_string(),
    }
}

/// Record session `session_id`'s output into `path` (chosen in the native
/// save dialog), replacing the file.
#[tauri::command]
pub fn start_recording(
    recorders: State<'_, Recorders>,
    session_id: String,
    path: String,
) -> Result<(), AppError> {
    start_recording_impl(&recorders, &session_id, &path)
}

fn start_recording_impl(
    recorders: &Recorders,
    session_id: &str,
    path: &str,
) -> Result<(), AppError> {
    let recorder = recorders
        .get(session_id)
        .ok_or_else(|| AppError::NotFound(format!("session {session_id}")))?;
    recorder.start(Path::new(path), false)
}

/// Stop recording session `session_id`. Unknown session ⇒ no-op.
#[tauri::command]
pub fn stop_recording(recorders: State<'_, Recorders>, session_id: String) {
    stop_recording_impl(&recorders, &session_id);
}

fn stop_recording_impl(recorders: &Recorders, session_id: &str) {
    if let Some(recorder) = recorders.get(session_id) {
        recorder.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starting_records_the_session_into_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.log");
        let recorders = Recorders::default();
        let recorder = recorders.open("s1");
        start_recording_impl(&recorders, "s1", path.to_str().unwrap()).unwrap();
        recorder.record(b"hi").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"hi");
    }

    #[test]
    fn starting_an_unknown_session_is_not_found() {
        let recorders = Recorders::default();
        let started = start_recording_impl(&recorders, "gone", "/tmp/x.log");
        assert!(matches!(started, Err(AppError::NotFound(_))));
    }

    #[test]
    fn stopping_ends_the_recording() {
        let dir = tempfile::tempdir().unwrap();
        let recorders = Recorders::default();
        let recorder = recorders.open("s1");
        recorder.start(&dir.path().join("out.log"), false).unwrap();
        stop_recording_impl(&recorders, "s1");
        assert!(!recorder.is_recording());
    }

    #[test]
    fn stopping_an_unknown_session_is_a_no_op() {
        stop_recording_impl(&Recorders::default(), "gone");
    }

    #[test]
    fn the_failed_payload_is_camel_case() {
        let payload = failed_payload("s1", &AppError::Io("disk full".into()));
        let json = serde_json::to_value(payload).unwrap();
        assert_eq!(json["sessionId"], "s1");
        assert!(json["message"].as_str().unwrap().contains("disk full"));
    }
}
