//! Host-key trust: prompt answers, the trusted-hosts list, and the events
//! every connection kind's sink uses to raise or close a prompt.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::error::AppError;
use crate::known_hosts::KnownHostEntry;
use crate::state::AppState;

pub(super) const HOST_KEY_PROMPT_EVENT: &str = "host_key_prompt";
const HOST_KEY_PROMPT_CLOSED_EVENT: &str = "host_key_prompt_closed";

/// Payload of the `host_key_prompt_closed` event: the prompt the backend is no
/// longer waiting on.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostKeyPromptClosedPayload {
    prompt_id: String,
}

pub(super) fn emit_host_key_prompt_closed(app: &AppHandle, prompt_id: &str) {
    let payload = HostKeyPromptClosedPayload {
        prompt_id: prompt_id.to_string(),
    };
    let _ = app.emit(HOST_KEY_PROMPT_CLOSED_EVENT, payload);
}

/// Resolve a pending host-key trust prompt (SPEC §5). Unknown/stale prompt ⇒
/// no-op. A prompt may belong to either a shell session or a tunnel (each
/// manager has its own registry), so the response is fanned out to both; the
/// one that owns the prompt resolves it and the other no-ops.
#[tauri::command]
pub fn respond_host_key(state: State<'_, AppState>, prompt_id: String, accept: bool) {
    state.session_manager.respond_host_key(&prompt_id, accept);
    state.tunnel_manager.respond_host_key(&prompt_id, accept);
    state.sftp_manager.respond_host_key(&prompt_id, accept);
}

/// List every trusted host key for the management UI. Fingerprints are public
/// data (not secrets), so this carries no keyring material.
#[tauri::command]
pub fn list_known_hosts(state: State<'_, AppState>) -> Result<Vec<KnownHostEntry>, AppError> {
    Ok(state.session_manager.known_hosts().list())
}

/// When the trusted hosts were reset after a damaged file (unix seconds), if
/// the user hasn't dismissed it: hosts without a record then prompt with a
/// warning instead of as first contacts.
#[tauri::command]
pub fn known_hosts_reset(state: State<'_, AppState>) -> Option<u64> {
    state.session_manager.known_hosts().reset_at()
}

/// Acknowledge the trusted hosts reset (see [`known_hosts_reset`]).
#[tauri::command]
pub async fn dismiss_known_hosts_reset(state: State<'_, AppState>) -> Result<(), AppError> {
    let known_hosts = state.session_manager.known_hosts();
    tokio::task::spawn_blocking(move || known_hosts.dismiss_reset())
        .await
        .map_err(|e| AppError::Io(format!("dismiss-reset task failed: {e}")))?
}

/// Forget a trusted host by its `host:port` id (management UI). Async because
/// the persist is a blocking `write`+`rename` syscall sequence, run on
/// `spawn_blocking` so it never stalls the async runtime. Forgetting an id that
/// no longer exists is not an error (`Ok(())`) — the row the user clicked is
/// simply already gone.
#[tauri::command]
pub async fn forget_host(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    let known_hosts = state.session_manager.known_hosts();
    tokio::task::spawn_blocking(move || known_hosts.forget(&id))
        .await
        .map_err(|e| AppError::Io(format!("forget-host task failed: {e}")))??;
    Ok(())
}
