//! Keyboard-interactive prompts (2FA codes, PAM questions): the events every
//! SSH connection kind's sink raises, and the command answering them.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use zeroize::Zeroizing;

use crate::ssh::prompts::AuthPromptPayload;
use crate::state::AppState;

const AUTH_PROMPT_EVENT: &str = "auth_prompt";
const AUTH_PROMPT_CLOSED_EVENT: &str = "auth_prompt_closed";

/// Payload of the `auth_prompt_closed` event: the prompt the backend is no
/// longer waiting on.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthPromptClosedPayload {
    prompt_id: String,
}

pub(super) fn emit_auth_prompt(app: &AppHandle, payload: AuthPromptPayload) {
    let _ = app.emit(AUTH_PROMPT_EVENT, payload);
}

pub(super) fn emit_auth_prompt_closed(app: &AppHandle, prompt_id: &str) {
    let payload = AuthPromptClosedPayload {
        prompt_id: prompt_id.to_string(),
    };
    let _ = app.emit(AUTH_PROMPT_CLOSED_EVENT, payload);
}

/// Answer a pending auth prompt (`answers: null` cancels it). Each manager
/// owns its prompts, so the first one holding `prompt_id` takes the answer;
/// unknown/stale ⇒ no-op.
#[tauri::command]
pub fn respond_auth_prompt(
    state: State<'_, AppState>,
    prompt_id: String,
    answers: Option<Vec<String>>,
) {
    let answers = answers.map(Zeroizing::new);
    let _ = state
        .session_manager
        .respond_auth(&prompt_id, answers.clone())
        || state
            .tunnel_manager
            .respond_auth(&prompt_id, answers.clone())
        || state.sftp_manager.respond_auth(&prompt_id, answers);
}

/// The dialog shows an auth prompt (one at a time): its answer time starts
/// now, not while it waited behind others. Unknown/stale ⇒ no-op.
#[tauri::command]
pub fn auth_prompt_shown(state: State<'_, AppState>, prompt_id: String) {
    let _ = state.session_manager.mark_auth_shown(&prompt_id)
        || state.tunnel_manager.mark_auth_shown(&prompt_id)
        || state.sftp_manager.mark_auth_shown(&prompt_id);
}
