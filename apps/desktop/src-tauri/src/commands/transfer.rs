//! Import/export of devices, profiles and the command library, and `~/.ssh/config` import/export.
//! The logic lives in `crate::transfer` and `crate::ssh_config`.

use std::path::Path;

use tauri::AppHandle;

use super::blocking::run_with_state;
use crate::error::AppError;
use crate::state::AppState;
use crate::transfer::DeviceRisks;

/// Export all devices to `path` (never includes secrets — `Device` has none).
#[tauri::command]
pub async fn export_devices(app: AppHandle, path: String) -> Result<u32, AppError> {
    run_with_state(app, move |state: &AppState| {
        crate::transfer::export_devices_impl(state, Path::new(&path))
    })
    .await
}

/// Validate the devices file at `path` and list the devices whose settings
/// would act on this machine, for the user to confirm before importing.
#[tauri::command]
pub async fn preview_devices_import(
    app: AppHandle,
    path: String,
) -> Result<Vec<DeviceRisks>, AppError> {
    run_with_state(app, move |state: &AppState| {
        crate::transfer::preview_devices_import_impl(state, Path::new(&path))
    })
    .await
}

/// Import devices from `path`: validate every item, then upsert by id
/// (all-or-nothing). `confirmed_risks` is what the user agreed to from
/// [`preview_devices_import`]; a file that no longer matches it is refused.
#[tauri::command]
pub async fn import_devices(
    app: AppHandle,
    path: String,
    confirmed_risks: Vec<DeviceRisks>,
) -> Result<u32, AppError> {
    run_with_state(app, move |state: &AppState| {
        crate::transfer::import_devices_impl(state, Path::new(&path), &confirmed_risks)
    })
    .await
}

/// Export all profiles to `path` (excludes `defaultProfileId`).
#[tauri::command]
pub async fn export_profiles(app: AppHandle, path: String) -> Result<u32, AppError> {
    run_with_state(app, move |state: &AppState| {
        crate::transfer::export_profiles_impl(state, Path::new(&path))
    })
    .await
}

/// Import profiles from `path`: validate every item, then upsert by id. Leaves
/// `defaultProfileId` untouched.
#[tauri::command]
pub async fn import_profiles(app: AppHandle, path: String) -> Result<u32, AppError> {
    run_with_state(app, move |state: &AppState| {
        crate::transfer::import_profiles_impl(state, Path::new(&path))
    })
    .await
}

/// Import SSH devices from an OpenSSH client config at `path` (typically
/// `~/.ssh/config`). Best-effort: each concrete `Host` block becomes an SSH
/// device; hosts that don't validate or duplicate an existing one are skipped,
/// never fatal. Returns the imported/skipped counts (see `ssh_config/`).
#[tauri::command]
pub async fn import_ssh_config(
    app: AppHandle,
    path: String,
) -> Result<crate::ssh_config::SshImportSummary, AppError> {
    run_with_state(app, move |state: &AppState| {
        crate::ssh_config::import_ssh_config_impl(state, Path::new(&path))
    })
    .await
}

/// Export every SSH device to an OpenSSH client config at `path` (the reverse of
/// `import_ssh_config`). Non-SSH devices (serial / local shell) are skipped.
/// Returns the exported/skipped counts. Never writes secret material — a
/// password lives only in the keyring, so an exported host with password auth
/// simply carries no credential line.
#[tauri::command]
pub async fn export_ssh_config(
    app: AppHandle,
    path: String,
) -> Result<crate::ssh_config::SshExportSummary, AppError> {
    run_with_state(app, move |state: &AppState| {
        crate::ssh_config::export_ssh_config_impl(state, Path::new(&path))
    })
    .await
}

/// Export the command library to `path`. Returns the count written.
#[tauri::command]
pub async fn export_commands(app: AppHandle, path: String) -> Result<u32, AppError> {
    run_with_state(app, move |state: &AppState| {
        crate::transfer::export_commands_impl(state, Path::new(&path))
    })
    .await
}

/// Import commands from `path`: validate every item, then upsert by id.
#[tauri::command]
pub async fn import_commands(app: AppHandle, path: String) -> Result<u32, AppError> {
    run_with_state(app, move |state: &AppState| {
        crate::transfer::import_commands_impl(state, Path::new(&path))
    })
    .await
}
