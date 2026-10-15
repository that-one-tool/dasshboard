//! SFTP edit in place. The heavy lifting lives in `crate::sftp_edit`
//! (download, watch, sync) and `crate::editor` (launching the editor).

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::sftp::sftp_progress_emitter;
use crate::editor;
use crate::error::AppError;
use crate::sftp_edit::{EditCheck, EditInfo, EditSink, EditUpload};
use crate::state::AppState;

/// Event name for "an edited file was saved locally" (see [`TauriEditSink`]).
const SFTP_EDIT_CHANGED_EVENT: &str = "sftp_edit_changed";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SftpEditChangedPayload {
    edit_id: String,
}

/// Production [`EditSink`]: tells the frontend an edited copy was saved, so it
/// can check for conflicts and queue the upload.
struct TauriEditSink {
    app: AppHandle,
}

impl EditSink for TauriEditSink {
    fn on_local_change(&self, edit_id: &str) {
        let payload = SftpEditChangedPayload {
            edit_id: edit_id.to_string(),
        };
        let _ = self.app.emit(SFTP_EDIT_CHANGED_EVENT, payload);
    }
}

/// Open an edit's local copy with the editor command from settings (or a text
/// editor).
fn launch_editor(state: &AppState, edit_id: &str) -> Result<(), AppError> {
    let path = state.edit_manager.local_path(edit_id)?;
    let command = state.settings_store.get().sftp.editor_command;
    editor::open_in_editor(&command, &path)
}

/// Download a remote file into a private local copy (streaming
/// `sftp_progress` like a download), watch it, and open it in the editor.
/// An editor that fails to start ends the edit again.
#[tauri::command]
pub async fn sftp_edit_open(
    app: AppHandle,
    state: State<'_, AppState>,
    device_id: String,
    remote_path: String,
) -> Result<EditInfo, AppError> {
    let progress = sftp_progress_emitter(app.clone(), device_id.clone(), "download");
    let sink: Arc<dyn EditSink> = Arc::new(TauriEditSink { app: app.clone() });
    let info = state
        .edit_manager
        .open(
            &state.sftp_manager,
            &device_id,
            &remote_path,
            sink,
            &progress,
        )
        .await?;
    if let Err(e) = launch_editor(&state, &info.edit_id) {
        state.edit_manager.close(&info.edit_id);
        return Err(e);
    }
    Ok(info)
}

/// The size of the file a remote path points to (following a symlink), or a
/// `Validation` error for a folder — checked before opening it for editing.
#[tauri::command]
pub async fn sftp_editable_size(
    state: State<'_, AppState>,
    device_id: String,
    path: String,
) -> Result<u64, AppError> {
    state.sftp_manager.editable_size(&device_id, &path).await
}

/// Open an already-downloaded edit in the editor again (it was closed).
#[tauri::command]
pub fn sftp_edit_launch(state: State<'_, AppState>, edit_id: String) -> Result<(), AppError> {
    launch_editor(&state, &edit_id)
}

/// Whether a saved edit needs uploading, and whether the remote changed too.
#[tauri::command]
pub async fn sftp_edit_check(
    state: State<'_, AppState>,
    edit_id: String,
) -> Result<EditCheck, AppError> {
    state
        .edit_manager
        .check(&state.sftp_manager, &edit_id)
        .await
}

/// Upload an edit's local copy over the remote file (streaming
/// `sftp_progress`). Refuses with `conflict` when the remote changed, unless
/// `overwrite`.
#[tauri::command]
pub async fn sftp_edit_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    edit_id: String,
    overwrite: bool,
) -> Result<EditUpload, AppError> {
    let device_id = state.edit_manager.info(&edit_id)?.device_id;
    let progress = sftp_progress_emitter(app, device_id, "upload");
    state
        .edit_manager
        .upload(&state.sftp_manager, &edit_id, overwrite, &progress)
        .await
}

/// Replace an edit's local copy with the current remote file, dropping the
/// local changes.
#[tauri::command]
pub async fn sftp_edit_discard(
    app: AppHandle,
    state: State<'_, AppState>,
    edit_id: String,
) -> Result<(), AppError> {
    let device_id = state.edit_manager.info(&edit_id)?.device_id;
    let progress = sftp_progress_emitter(app, device_id, "download");
    state
        .edit_manager
        .discard(&state.sftp_manager, &edit_id, &progress)
        .await
}

/// Stop an edit: no more uploads, and its local copy is deleted.
#[tauri::command]
pub fn sftp_edit_close(state: State<'_, AppState>, edit_id: String) -> Result<(), AppError> {
    state.edit_manager.close(&edit_id);
    Ok(())
}
