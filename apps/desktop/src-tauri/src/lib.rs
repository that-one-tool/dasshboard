// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod agent_ident;
mod app_menu;
mod atomic_file;
mod bookmark_store;
mod commands;
mod config_watch;
mod local_shell;
mod profile;
mod profile_store;
mod secret;
mod serial;
mod settings;
mod socks;
mod ssh_config;
mod state;
mod store;
mod transfer;
mod tray;
mod updater;
mod workspace;
mod workspace_store;

// These modules are `pub` (not private `mod`) solely so the in-process
// integration tests in `tests/` — a separate crate — can reach the types they
// drive (`SessionManager`, `SftpManager`, `TunnelManager`, their param structs,
// etc.). `#[doc(hidden)]` keeps them out of the public docs; this lib is
// consumed only by the app's own binary, never as an external dependency.
#[doc(hidden)]
pub mod device;
#[doc(hidden)]
pub mod error;
#[doc(hidden)]
pub mod known_hosts;
#[doc(hidden)]
pub mod session;
#[doc(hidden)]
pub mod sftp;
#[doc(hidden)]
pub mod tunnel;

// The in-process SSH/SFTP integration tests live in `tests/` (a separate
// crate), driving the library through its public API — see `tests/ssh_it.rs`
// and `tests/sftp_it.rs`.

use std::sync::Arc;

use tauri::{AppHandle, Manager, RunEvent, Runtime};

use bookmark_store::BookmarkStore;
use known_hosts::KnownHostsStore;
use local_shell::LocalShellManager;
use profile_store::ProfileStore;
use secret::KeyringSecretStore;
use serial::SerialSessionManager;
use session::SessionManager;
use settings::SettingsStore;
use state::AppState;
use store::DeviceStore;
use tunnel::TunnelManager;
use workspace_store::WorkspaceStore;

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
    // Before anything can run an update check (which may set TLS env vars).
    local_shell::record_startup_env();
    let builder = tauri::Builder::default();
    // Tauri installs its default menu bar on macOS only; ours drops Cmd+W.
    let builder = if cfg!(target_os = "macos") {
        builder.menu(app_menu::macos_menu)
    } else {
        builder
    };
    builder
        .plugin(tauri_plugin_opener::init())
        // Persist and restore the window size/position across restarts (Phase 5).
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // Native save/open file pickers backing devices/profiles import/export.
        .plugin(tauri_plugin_dialog::init())
        // In-app updates; only ever invoked by `check_update`/`install_update`.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updater::PendingUpdate::default())
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
            // Per-instance open-tabs layout (Tabs milestone, Phase 3). Same
            // app-config dir; restored on launch, saved (debounced) on change.
            let workspace_store = WorkspaceStore::load(config_dir.clone());
            // Per-device SFTP bookmarks (saved remote paths). Same app-config dir.
            let bookmark_store = BookmarkStore::load(config_dir.clone());
            // Host-key TOFU store + SSH session manager (SPEC.md §3/§6). The
            // manager owns the known-hosts store (behind an `Arc`) so its
            // session tasks can consult/persist trust decisions.
            let known_hosts = Arc::new(KnownHostsStore::load(config_dir.clone()));
            let session_manager = Arc::new(SessionManager::with_defaults(known_hosts));
            // Tunnels (local port-forwarding) share the SSH manager's host-key
            // TOFU store, so a trust decision applies to shells and tunnels to
            // the same host alike (SPEC tunnels §2/§4).
            let tunnel_manager =
                Arc::new(TunnelManager::with_defaults(session_manager.known_hosts()));
            // SFTP connections (the Files drawer) likewise share the host-key
            // TOFU store, so trust decisions are consistent across shells,
            // tunnels and SFTP to the same host.
            let sftp_manager = Arc::new(sftp::SftpManager::with_defaults(
                session_manager.known_hosts(),
            ));
            // Serial/COM sessions live in their own manager, alongside the SSH one.
            let serial_manager = Arc::new(SerialSessionManager::new());
            // Local shell sessions (PTY-backed) live in their own manager too.
            let local_shell_manager = Arc::new(LocalShellManager::new());
            let secret_store: Arc<dyn secret::SecretStore> = Arc::new(KeyringSecretStore);
            app.manage(AppState {
                device_store,
                profile_store,
                settings_store,
                workspace_store,
                secret_store,
                session_manager,
                tunnel_manager,
                sftp_manager,
                serial_manager,
                local_shell_manager,
                bookmark_store,
            });
            // Watch the config dir so a change made by another running instance
            // (multi-instance sync) is picked up automatically: it emits a
            // debounced `config_changed` event that the frontend answers by
            // reloading. Best-effort — a watcher failure just disables the
            // automatic layer; the manual Reload button is unaffected.
            config_watch::spawn(app.handle().clone(), config_dir);
            // Opt-in close-to-tray: shows the tray icon when the setting is on.
            tray::init(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                on_close_requested(window, api);
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
            commands::start_tunnel,
            commands::stop_tunnel,
            commands::list_tunnels,
            commands::list_profiles,
            commands::save_profile,
            commands::delete_profile,
            commands::set_default_profile,
            commands::get_settings,
            commands::save_settings,
            commands::get_workspace_state,
            commands::save_workspace_state,
            commands::reload_config,
            commands::export_devices,
            commands::import_devices,
            commands::export_profiles,
            commands::import_profiles,
            commands::import_ssh_config,
            commands::export_ssh_config,
            commands::ssh_agent_available,
            commands::list_agent_identities,
            commands::sftp_connect,
            commands::sftp_disconnect,
            commands::sftp_list,
            commands::sftp_realpath,
            commands::sftp_connected_devices,
            commands::sftp_download,
            commands::sftp_upload,
            commands::sftp_download_dir,
            commands::sftp_upload_dir,
            commands::sftp_local_exists,
            commands::sftp_exists,
            commands::sftp_cancel_transfer,
            commands::sftp_mkdir,
            commands::sftp_rename,
            commands::sftp_remove,
            commands::sftp_chmod,
            commands::sftp_bookmarks,
            commands::sftp_bookmark_add,
            commands::sftp_bookmark_remove,
            commands::check_update,
            commands::download_update,
            commands::install_update,
            commands::set_tray_labels,
            commands::live_session_count,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            RunEvent::Exit => close_sessions_on_exit(app),
            // Clicking the Dock icon brings back a window hidden to the tray.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => tray::show_main_window(app),
            _ => {}
        });
}

/// Window close: hide to the tray when opted in; otherwise (SPEC §7) gracefully
/// disconnect every live SSH session before the window goes away, so the remote
/// sees a clean SSH disconnect rather than a dropped TCP socket on process exit.
/// The disconnect is bounded by its own ~1s timeout so a stuck session can't
/// hang the quit; `destroy()` fires no further `CloseRequested`, so there is no
/// re-entrancy loop.
fn on_close_requested<R: Runtime>(window: &tauri::Window<R>, api: &tauri::CloseRequestApi) {
    match tray::close_action_for(window.app_handle()) {
        tray::CloseAction::Close => {}
        tray::CloseAction::HideToTray => {
            api.prevent_close();
            let _ = window.hide();
        }
        tray::CloseAction::ShutdownThenClose => {
            api.prevent_close();
            let window = window.clone();
            tauri::async_runtime::spawn(async move {
                window.state::<AppState>().shutdown_live_sessions().await;
                let _ = window.destroy();
            });
        }
    }
}

/// Quitting from the macOS menu or Dock (Cmd+Q) ends the event loop without a
/// `CloseRequested`, so the graceful disconnect runs here as well. After a
/// normal window close nothing is live any more, so this is a no-op.
fn close_sessions_on_exit<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    if state.has_live_sessions() {
        tauri::async_runtime::block_on(state.shutdown_live_sessions());
    }
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
