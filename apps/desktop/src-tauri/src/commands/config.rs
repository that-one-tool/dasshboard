//! Settings, the open-tabs workspace, and the multi-instance config reload.

use tauri::{AppHandle, Manager, State};

use crate::error::AppError;
use crate::settings::Settings;
use crate::state::AppState;
use crate::workspace::WorkspaceState;

fn get_settings_impl(state: &AppState) -> Settings {
    state.settings_store.get()
}

fn save_settings_impl(state: &AppState, settings: Settings) -> Result<Settings, AppError> {
    state.settings_store.save(settings)
}

fn get_workspace_state_impl(state: &AppState) -> WorkspaceState {
    state.workspace_store.get()
}

fn save_workspace_state_impl(state: &AppState, workspace: WorkspaceState) -> Result<(), AppError> {
    state.workspace_store.save(workspace)
}

/// Re-reads every persisted config file (devices, profiles, settings, known
/// hosts) from disk into the in-memory stores, so a second running app instance
/// picks up changes another instance made. Each store caches its file at
/// startup; without this a change in instance A stays invisible to instance B
/// until B restarts. Secrets are unaffected — they are read live from the OS
/// keyring, never cached. The known-hosts store is shared by the SSH session
/// and tunnel managers, so reloading it once refreshes both.
///
/// Infallible: each store's `reload` recovers from a missing or corrupt file
/// exactly like its startup `load`, so there is nothing to report back.
fn reload_config_impl(state: &AppState) {
    state.device_store.reload();
    state.profile_store.reload();
    state.settings_store.reload();
    state.session_manager.known_hosts().reload();
    state.bookmark_store.reload();
}

/// Current app settings — terminal appearance + last-used grid (SPEC.md §5).
#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<Settings, AppError> {
    Ok(get_settings_impl(&state))
}

/// Persists app settings (sanitized: font size clamped, empty family defaulted)
/// and returns the stored value (SPEC.md §5). Shows or hides the tray icon to
/// match the close-to-tray setting.
#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    mut settings: Settings,
) -> Result<Settings, AppError> {
    // Stored as off when the tray can't be built, so the checkbox reflects it.
    settings.tray.close_to_tray = crate::tray::set_enabled(&app, settings.tray.close_to_tray);
    save_settings_impl(&state, settings)
}

/// The saved open-tabs workspace (Tabs milestone, Phase 3). Empty `tabs` means
/// nothing has been persisted yet — the frontend then falls back to the
/// default/last profile (the `lastProfileId` migration).
#[tauri::command]
pub fn get_workspace_state(state: State<'_, AppState>) -> Result<WorkspaceState, AppError> {
    Ok(get_workspace_state_impl(&state))
}

/// Persists the open-tabs workspace (validated, atomic). Per-instance UI state:
/// `workspace_state.json` is deliberately excluded from the config watcher, so
/// this write never triggers a multi-instance reload.
#[tauri::command]
pub fn save_workspace_state(
    state: State<'_, AppState>,
    workspace: WorkspaceState,
) -> Result<(), AppError> {
    save_workspace_state_impl(&state, workspace)
}

/// Reloads every persisted config file from disk into memory (multi-instance
/// sync — see [`reload_config_impl`]). The frontend invokes this before
/// re-fetching its lists so the list commands serve the freshly-read data
/// rather than the startup cache. The reads run on a blocking worker: they
/// retry a locked file with short sleeps, which must not freeze the UI.
#[tauri::command]
pub async fn reload_config(app: AppHandle) -> Result<(), AppError> {
    let reload_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        reload_config_impl(&reload_app.state::<AppState>())
    })
    .await
    .map_err(|e| AppError::Io(format!("reload task failed: {e}")))?;
    // Another instance may have toggled close-to-tray. Only reflected, never
    // written back, so a reload can't clobber the other instance's setting.
    // The tray is only ever touched on the main thread.
    let close_to_tray = app
        .state::<AppState>()
        .settings_store
        .get()
        .tray
        .close_to_tray;
    let tray_app = app.clone();
    app.run_on_main_thread(move || {
        crate::tray::set_enabled(&tray_app, close_to_tray);
    })
    .map_err(|e| AppError::Io(format!("tray update failed: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::devices::{list_devices_impl, save_device_impl};
    use crate::commands::profiles::{list_profiles_impl, save_profile_impl};
    use crate::commands::test_support::*;
    use tempfile::tempdir;

    #[test]
    fn reload_config_refreshes_every_store_from_disk() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());

        // This instance starts empty across all stores.
        assert!(list_devices_impl(&state).is_empty());
        assert!(list_profiles_impl(&state).profiles.is_empty());
        assert_eq!(state.session_manager.known_hosts().list().len(), 0);

        // A second instance (same config dir) writes to each config file.
        let other = test_state(dir.path());
        save_device_impl(&other, sample_device(), Some("pw".to_string())).unwrap();
        save_profile_impl(&other, profile_referencing("dev-1")).unwrap();
        other
            .session_manager
            .known_hosts()
            .trust(
                "h",
                22,
                crate::known_hosts::KnownHost {
                    key_type: "ssh-ed25519".to_string(),
                    fingerprint: "SHA256:abc".to_string(),
                },
            )
            .unwrap();
        other.bookmark_store.add("dev-1", "/etc").unwrap();

        // Our in-memory view is stale until reloaded.
        assert!(list_devices_impl(&state).is_empty(), "stale until reload");

        reload_config_impl(&state);

        assert_eq!(list_devices_impl(&state).len(), 1);
        assert_eq!(list_profiles_impl(&state).profiles.len(), 1);
        assert_eq!(state.session_manager.known_hosts().list().len(), 1);
        assert_eq!(state.bookmark_store.list("dev-1"), ["/etc"]);
    }
}
