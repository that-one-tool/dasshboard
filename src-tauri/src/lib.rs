// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod device;
mod error;
mod known_hosts;
mod profile;
mod profile_store;
mod secret;
mod serial;
mod session;
mod settings;
mod state;
mod store;
mod transfer;

#[cfg(test)]
mod ssh_it;

use std::sync::Arc;

use tauri::Manager;

use known_hosts::KnownHostsStore;
use profile_store::ProfileStore;
use secret::KeyringSecretStore;
use serial::SerialSessionManager;
use session::SessionManager;
use settings::SettingsStore;
use state::AppState;
use store::DeviceStore;

/// Returns the application's semantic version, as recorded in `Cargo.toml`.
///
/// Kept as a small pure function (rather than inlined in the `ping` command,
/// which lives in `commands.rs`) so it has a unit test independent of the Tauri
/// runtime.
pub(crate) fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Persist and restore the window size/position across restarts (Phase 5).
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // Native save/open file pickers backing devices/profiles import/export.
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // SPEC.md §4: all persisted JSON lives in the Tauri app-config
            // dir. DeviceStore itself takes a plain directory path (not an
            // AppHandle), so this is the only place that couples it to
            // Tauri's path resolver — tests inject a temp dir directly.
            let config_dir = app.path().app_config_dir()?;
            let device_store = DeviceStore::load(config_dir.clone());
            // Saved workspace layouts (SPEC.md §4). Same app-config dir as the
            // device store; tests inject a temp dir directly.
            let profile_store = ProfileStore::load(config_dir.clone());
            // App settings (SPEC.md §4): terminal appearance + last-used grid.
            let settings_store = SettingsStore::load(config_dir.clone());
            // Host-key TOFU store + SSH session manager (SPEC.md §3/§6). The
            // manager owns the known-hosts store (behind an `Arc`) so its
            // session tasks can consult/persist trust decisions.
            let known_hosts = Arc::new(KnownHostsStore::load(config_dir));
            let session_manager = Arc::new(SessionManager::with_defaults(known_hosts));
            // Serial/COM sessions live in their own manager, alongside the SSH one.
            let serial_manager = Arc::new(SerialSessionManager::new());
            let secret_store: Arc<dyn secret::SecretStore> = Arc::new(KeyringSecretStore);
            app.manage(AppState {
                device_store,
                profile_store,
                settings_store,
                secret_store,
                session_manager,
                serial_manager,
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // App close (SPEC §7): gracefully disconnect every live SSH session
            // before the window goes away, so the remote sees a clean SSH
            // disconnect rather than a dropped TCP socket on process exit. We
            // prevent the immediate close, run `disconnect_all` (bounded by its
            // own ~1s timeout so a stuck session can't hang the quit), then
            // `destroy()` to actually close. `destroy()` fires no further
            // `CloseRequested`, so there is no re-entrancy loop.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                let manager = Arc::clone(&state.session_manager);
                let serial = Arc::clone(&state.serial_manager);
                if manager.session_count() == 0 && serial.session_count() == 0 {
                    return; // nothing live — let the close proceed normally.
                }
                api.prevent_close();
                let window = window.clone();
                tauri::async_runtime::spawn(async move {
                    manager.disconnect_all().await;
                    serial.disconnect_all().await;
                    let _ = window.destroy();
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::list_devices,
            commands::save_device,
            commands::delete_device,
            commands::connect,
            commands::write_stdin,
            commands::resize_pty,
            commands::disconnect,
            commands::respond_host_key,
            commands::list_known_hosts,
            commands::forget_host,
            commands::test_connection,
            commands::list_profiles,
            commands::save_profile,
            commands::delete_profile,
            commands::set_default_profile,
            commands::get_settings,
            commands::save_settings,
            commands::export_devices,
            commands::import_devices,
            commands::export_profiles,
            commands::import_profiles,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_version_matches_cargo_toml() {
        assert_eq!(app_version(), env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn app_version_looks_like_semver() {
        let version = app_version();
        let parts: Vec<&str> = version.split('.').collect();
        assert_eq!(
            parts.len(),
            3,
            "expected MAJOR.MINOR.PATCH, got {version:?}"
        );
        for part in parts {
            assert!(
                !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()),
                "non-numeric version segment: {part:?}"
            );
        }
    }
}
