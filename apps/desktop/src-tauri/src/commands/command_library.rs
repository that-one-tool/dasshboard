//! The command library: reusable commands the frontend sends to panes. Plain
//! data, the store in `crate::command_library` does the work.

use tauri::State;

use crate::command_library::SavedCommand;
use crate::error::AppError;
use crate::state::AppState;

#[tauri::command]
pub fn list_commands(state: State<'_, AppState>) -> Vec<SavedCommand> {
    state.command_store.list()
}

/// Create (empty id) or replace a command. Returns it as saved.
#[tauri::command]
pub fn save_command(
    state: State<'_, AppState>,
    command: SavedCommand,
) -> Result<SavedCommand, AppError> {
    state.command_store.upsert(command)
}

#[tauri::command]
pub fn delete_command(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    state.command_store.delete(&id)
}
