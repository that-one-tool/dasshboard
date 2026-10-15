//! Import/export of devices and profiles, and `~/.ssh/config` import/export.
//! The logic lives in `crate::transfer` and `crate::ssh_config`.

use std::path::Path;

use tauri::State;

use crate::error::AppError;
use crate::state::AppState;
use crate::transfer::DeviceRisks;

/// Export all devices to `path` (never includes secrets — `Device` has none).
#[tauri::command]
pub fn export_devices(state: State<'_, AppState>, path: String) -> Result<u32, AppError> {
    crate::transfer::export_devices_impl(&state, Path::new(&path))
}

/// Validate the devices file at `path` and list the devices whose settings
/// would act on this machine, for the user to confirm before importing.
#[tauri::command]
pub fn preview_devices_import(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<DeviceRisks>, AppError> {
    crate::transfer::preview_devices_import_impl(&state, Path::new(&path))
}

/// Import devices from `path`: validate every item, then upsert by id
/// (all-or-nothing). `confirmed_risks` is what the user agreed to from
/// [`preview_devices_import`]; a file that no longer matches it is refused.
#[tauri::command]
pub fn import_devices(
    state: State<'_, AppState>,
    path: String,
    confirmed_risks: Vec<DeviceRisks>,
) -> Result<u32, AppError> {
    crate::transfer::import_devices_impl(&state, Path::new(&path), &confirmed_risks)
}

/// Export all profiles to `path` (excludes `defaultProfileId`).
#[tauri::command]
pub fn export_profiles(state: State<'_, AppState>, path: String) -> Result<u32, AppError> {
    crate::transfer::export_profiles_impl(&state, Path::new(&path))
}

/// Import profiles from `path`: validate every item, then upsert by id. Leaves
/// `defaultProfileId` untouched.
#[tauri::command]
pub fn import_profiles(state: State<'_, AppState>, path: String) -> Result<u32, AppError> {
    crate::transfer::import_profiles_impl(&state, Path::new(&path))
}

/// Import SSH devices from an OpenSSH client config at `path` (typically
/// `~/.ssh/config`). Best-effort: each concrete `Host` block becomes an SSH
/// device; hosts that don't validate or duplicate an existing one are skipped,
/// never fatal. Returns the imported/skipped counts (see `ssh_config.rs`).
#[tauri::command]
pub fn import_ssh_config(
    state: State<'_, AppState>,
    path: String,
) -> Result<crate::ssh_config::SshImportSummary, AppError> {
    crate::ssh_config::import_ssh_config_impl(&state, Path::new(&path))
}

/// Export every SSH device to an OpenSSH client config at `path` (the reverse of
/// `import_ssh_config`). Non-SSH devices (serial / local shell) are skipped.
/// Returns the exported/skipped counts. Never writes secret material — a
/// password lives only in the keyring, so an exported host with password auth
/// simply carries no credential line.
#[tauri::command]
pub fn export_ssh_config(
    state: State<'_, AppState>,
    path: String,
) -> Result<crate::ssh_config::SshExportSummary, AppError> {
    crate::ssh_config::export_ssh_config_impl(&state, Path::new(&path))
}
