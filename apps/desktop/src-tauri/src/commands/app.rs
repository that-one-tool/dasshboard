//! App-level commands: version ping, updates, tray, local probes, saving text.

use tauri::{AppHandle, State};

use crate::error::AppError;
use crate::state::AppState;
use crate::updater::{self, PendingUpdate, UpdateInfo};

/// Live shell sessions, tunnels and SFTP connections — the tray menu's count,
/// read once by the frontend after it subscribes to changes.
#[tauri::command]
pub fn live_session_count(state: State<'_, AppState>) -> usize {
    state.live_session_count()
}

/// Updates the tray menu with labels the frontend translated (and pluralized).
#[tauri::command]
pub fn set_tray_labels(app: AppHandle, labels: crate::tray::TrayLabels) {
    crate::tray::set_labels(&app, labels);
}

/// Checks the update server for a newer release (user-initiated or opted-in
/// launch check only). `None` when up to date.
#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<UpdateInfo>, AppError> {
    updater::check(&app, &pending).await
}

/// Downloads and verifies the update the user confirmed (`version`), without
/// touching live sessions, so a failure is harmless and retryable.
#[tauri::command]
pub async fn download_update(
    pending: State<'_, PendingUpdate>,
    version: String,
) -> Result<(), AppError> {
    updater::download(&pending, &version).await
}

/// Installs the downloaded update (`version`), closing live sessions first,
/// then restarts the app.
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
    version: String,
) -> Result<(), AppError> {
    updater::install(&app, &pending, &version).await
}

/// Walking-skeleton IPC command (Phase 0): proves the frontend <-> backend
/// round trip works end to end. Returns the app's semantic version.
#[tauri::command]
pub fn ping() -> String {
    crate::app_version()
}

/// Write a terminal's saved output to `path`, chosen in the native save dialog.
#[tauri::command]
pub fn save_text_file(path: String, contents: String) -> Result<(), AppError> {
    std::fs::write(path, contents)?;
    Ok(())
}

/// Whether a local SSH agent looks reachable, for the device editor's
/// agent-forwarding hint. Best-effort: the toggle stays usable either way, since
/// forwarding simply no-ops per channel if the agent is unavailable at connect
/// time.
#[tauri::command]
pub fn ssh_agent_available() -> bool {
    crate::agent::agent_available()
}

/// List the public keys held by the local SSH agent (spike prototype for
/// hardware-token auth). Returns algorithm + SHA256 fingerprint per key; an
/// empty list means the agent is running but holds no keys. Never exposes key
/// material.
#[tauri::command]
pub async fn list_agent_identities() -> Result<Vec<crate::agent_ident::AgentIdentityInfo>, AppError>
{
    crate::agent_ident::list_agent_identities().await
}
