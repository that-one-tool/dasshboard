//! The command library: reusable commands the frontend sends to panes. Plain
//! data, the store in `crate::command_library` does the work.

use tauri::{AppHandle, State};

use super::blocking::run_with_state;
use crate::command_library::SavedCommand;
use crate::error::AppError;
use crate::state::AppState;

#[tauri::command]
pub fn list_commands(state: State<'_, AppState>) -> Vec<SavedCommand> {
    state.command_store.list()
}

/// Create (empty id) or replace a command. Returns it as saved.
#[tauri::command]
pub async fn save_command(app: AppHandle, command: SavedCommand) -> Result<SavedCommand, AppError> {
    run_with_state(app, move |state: &AppState| {
        state.command_store.upsert(command)
    })
    .await
}

#[tauri::command]
pub async fn delete_command(app: AppHandle, id: String) -> Result<(), AppError> {
    run_with_state(app, move |state: &AppState| state.command_store.delete(&id)).await
}
