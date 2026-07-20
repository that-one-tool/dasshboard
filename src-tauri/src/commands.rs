//! Tauri commands for device management (SPEC.md §5). Each `#[tauri::command]`
//! is a thin wrapper around an `*_impl` function that takes `&AppState`
//! directly — the `impl` functions hold all the actual logic and are what
//! the unit tests below exercise, since constructing a real `tauri::State`
//! outside a running app isn't possible.
//!
//! Argument names are `snake_case` in Rust; Tauri's command macro converts
//! them to `camelCase` on the wire by default (e.g. `device_id` here is
//! invoked from the frontend as `{ deviceId: ... }`).

use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::device::{Auth, Device};
use crate::error::AppError;
use crate::profile::Profile;
use crate::profile_store::ProfileList;
use crate::session::{AuthCredentials, HostKeyPromptPayload, SessionSink, SessionStatus};
use crate::settings::Settings;
use crate::state::AppState;

fn list_devices_impl(state: &AppState) -> Vec<Device> {
    state.device_store.list()
}

fn save_device_impl(
    state: &AppState,
    device: Device,
    secret: Option<String>,
) -> Result<Device, AppError> {
    // Capture the previously-stored auth method (if this is an edit of an
    // existing device) *before* the upsert overwrites it, so we can tell
    // whether the auth method is changing.
    let previous_method = state
        .device_store
        .list()
        .into_iter()
        .find(|d| d.id == device.id)
        .map(|d| d.auth.method_name());
    let incoming_method = device.auth.method_name();

    let saved = state.device_store.upsert(device)?;

    match secret {
        // A new secret was supplied: write it verbatim.
        Some(secret) => state.secret_store.set(&saved.id, &secret)?,
        // No secret supplied. The usual meaning is "leave the existing keyring
        // entry untouched" (the common edit case behind SPEC §7's "unchanged"
        // placeholder). But if the auth method just changed, any stored secret
        // belongs to the *old* method — a password is not a key passphrase and
        // vice versa — and Phase 2's SSH auth would otherwise misuse it. Per
        // SPEC §4 a `key` device with no passphrase must have NO secret stored,
        // so clear the stranded secret on an auth-method change.
        None => {
            if previous_method.is_some_and(|prev| prev != incoming_method) {
                state.secret_store.delete(&saved.id)?;
            }
        }
    }
    Ok(saved)
}

fn delete_device_impl(state: &AppState, device_id: &str) -> Result<(), AppError> {
    // If the device itself doesn't exist, `delete` returns `NotFound` via
    // `?` and we never reach the cleanup below.
    state.device_store.delete(device_id)?;
    // The device is now gone from devices.json (irreversible), so run BOTH
    // cleanups unconditionally — a failure in one must not skip the other and
    // strand a dangling reference. A missing keyring entry (e.g. a password-less
    // key device, or one never saved with a secret) is not an error (SPEC.md §5).
    let secret_res = state.secret_store.delete(device_id);
    // Referential cleanup (PLAN.md Phase 4 task 4): null this device out of any
    // profile pane that referenced it, so a saved layout never points at a device
    // that no longer exists. Only rewrites profiles.json if a pane referenced it.
    let profile_res = state.profile_store.clear_device(device_id);
    secret_res?;
    profile_res?;
    Ok(())
}

fn list_profiles_impl(state: &AppState) -> ProfileList {
    state.profile_store.list()
}

fn save_profile_impl(state: &AppState, profile: Profile) -> Result<Profile, AppError> {
    state.profile_store.upsert(profile)
}

fn delete_profile_impl(state: &AppState, profile_id: &str) -> Result<(), AppError> {
    state.profile_store.delete(profile_id)
}

fn set_default_profile_impl(state: &AppState, profile_id: Option<String>) -> Result<(), AppError> {
    state.profile_store.set_default(profile_id)
}

fn get_settings_impl(state: &AppState) -> Settings {
    state.settings_store.get()
}

fn save_settings_impl(state: &AppState, settings: Settings) -> Result<Settings, AppError> {
    state.settings_store.save(settings)
}

/// Never includes secret material — `Device` has no secret field to begin
/// with (SPEC.md §4/§8).
#[tauri::command]
pub fn list_devices(state: State<'_, AppState>) -> Result<Vec<Device>, AppError> {
    Ok(list_devices_impl(&state))
}

/// Upserts by `device.id` (empty id ⇒ create with a new UUID). `secret`
/// present ⇒ written to the keyring under the (possibly new) device id;
/// absent ⇒ any existing secret is left untouched, *except* when the device's
/// auth method changed in this save, in which case the now-stale secret is
/// deleted so no orphaned password/passphrase remains (SPEC.md §4/§5).
#[tauri::command]
pub fn save_device(
    state: State<'_, AppState>,
    device: Device,
    secret: Option<String>,
) -> Result<Device, AppError> {
    save_device_impl(&state, device, secret)
}

/// Deletes the device, its keyring entry (if any), and nulls it out of any
/// profile pane that referenced it (SPEC.md §5, PLAN.md Phase 4 task 4).
#[tauri::command]
pub fn delete_device(state: State<'_, AppState>, device_id: String) -> Result<(), AppError> {
    delete_device_impl(&state, &device_id)
}

/* ============================================================================
 * Profile commands (SPEC.md §5, Phase 4)
 * ============================================================================ */

/// All saved layouts plus the current default id (SPEC.md §5). Profiles hold
/// only device ids, never secrets.
#[tauri::command]
pub fn list_profiles(state: State<'_, AppState>) -> Result<ProfileList, AppError> {
    Ok(list_profiles_impl(&state))
}

/// Upserts a profile by `profile.id` (empty id ⇒ create with a new UUID).
#[tauri::command]
pub fn save_profile(state: State<'_, AppState>, profile: Profile) -> Result<Profile, AppError> {
    save_profile_impl(&state, profile)
}

/// Deletes a profile; clears `defaultProfileId` if it pointed at it (SPEC.md §5).
#[tauri::command]
pub fn delete_profile(state: State<'_, AppState>, profile_id: String) -> Result<(), AppError> {
    delete_profile_impl(&state, &profile_id)
}

/// Sets or clears (`null`) the default profile loaded on app start (SPEC.md §5).
#[tauri::command]
pub fn set_default_profile(
    state: State<'_, AppState>,
    profile_id: Option<String>,
) -> Result<(), AppError> {
    set_default_profile_impl(&state, profile_id)
}

/* ============================================================================
 * Settings commands (SPEC.md §5, Phase 5)
 * ============================================================================ */

/// Current app settings — terminal appearance + last-used grid (SPEC.md §5).
#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<Settings, AppError> {
    Ok(get_settings_impl(&state))
}

/// Persists app settings (sanitized: font size clamped, empty family defaulted)
/// and returns the stored value (SPEC.md §5).
#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<Settings, AppError> {
    save_settings_impl(&state, settings)
}

/* ============================================================================
 * SSH session commands (SPEC.md §5–6, Phase 2)
 * ============================================================================ */

const SESSION_STATUS_EVENT: &str = "session_status";
const HOST_KEY_PROMPT_EVENT: &str = "host_key_prompt";

/// Wire payload of the `session_status` event (SPEC.md §5), `camelCase`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionStatusPayload {
    session_id: String,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

/// Production [`SessionSink`]: streams terminal bytes over the per-session IPC
/// `Channel` and emits `session_status` / `host_key_prompt` Tauri events. It
/// carries only the session id and non-secret payloads — never a credential.
struct TauriSessionSink {
    app: AppHandle,
    session_id: String,
    /// `Some` for a live session (its per-session data channel); `None` for
    /// `test_connection`, which has no shell and streams no data.
    channel: Option<Channel<InvokeResponseBody>>,
}

impl SessionSink for TauriSessionSink {
    fn on_data(&self, bytes: &[u8]) {
        if let Some(channel) = &self.channel {
            // Verbatim server output (SPEC §3). `InvokeResponseBody::Raw` is
            // delivered to JS as an `ArrayBuffer`, which the frontend wraps in a
            // `Uint8Array` for `terminal.write()`. A send error just means the
            // frontend dropped the channel; the session loop ends on its own.
            let _ = channel.send(InvokeResponseBody::Raw(bytes.to_vec()));
        }
    }

    fn on_status(&self, status: SessionStatus, message: Option<String>) {
        let _ = self.app.emit(
            SESSION_STATUS_EVENT,
            SessionStatusPayload {
                session_id: self.session_id.clone(),
                status: status.as_str(),
                message,
            },
        );
    }

    fn on_host_key_prompt(&self, payload: HostKeyPromptPayload) {
        let _ = self.app.emit(HOST_KEY_PROMPT_EVENT, payload);
    }
}

/// Look up a device by id (SPEC §5 `NotFound` on miss).
fn find_device(state: &AppState, device_id: &str) -> Result<Device, AppError> {
    state
        .device_store
        .list()
        .into_iter()
        .find(|d| d.id == device_id)
        .ok_or_else(|| AppError::NotFound(format!("no device with id {device_id}")))
}

/// Pure part of credential-building (SPEC §6): combine a device's auth method
/// with the secret already fetched from the keyring. No I/O — kept separate so
/// it is trivially unit-testable and so the blocking keyring read can happen
/// off the async runtime (see [`resolve_credentials`]). The secret never
/// leaves this function except inside the opaque [`AuthCredentials`], and never
/// appears in an error message.
fn credentials_from(auth: &Auth, stored: Option<String>) -> Result<AuthCredentials, AppError> {
    match auth {
        Auth::Password => {
            let password = stored.ok_or_else(|| {
                AppError::SshAuth(
                    "no password is stored for this device — open the device editor and re-enter it"
                        .to_string(),
                )
            })?;
            Ok(AuthCredentials::Password(password))
        }
        Auth::Key { key_path } => {
            // A missing keyring secret means an unencrypted key (SPEC §4), which
            // is valid — not an error.
            Ok(AuthCredentials::Key {
                path: key_path.clone(),
                passphrase: stored,
            })
        }
    }
}

/// Fetch the device's keyring secret and build its [`AuthCredentials`] (SPEC
/// §6). The keyring read is a blocking OS call (Windows Credential Manager), so
/// it runs on `tokio::task::spawn_blocking` rather than directly on the async
/// runtime — a slow/contended keyring must never stall other sessions' PTY I/O
/// or keepalives. No lock is held across the `.await` (the `Arc<dyn
/// SecretStore>` is cloned out first).
async fn resolve_credentials(
    state: &AppState,
    device: &Device,
) -> Result<AuthCredentials, AppError> {
    let secret_store = Arc::clone(&state.secret_store);
    let device_id = device.id.clone();
    let stored = tokio::task::spawn_blocking(move || secret_store.get(&device_id))
        .await
        .map_err(|e| AppError::Keyring(format!("secret lookup task failed: {e}")))??;
    credentials_from(&device.auth, stored)
}

/// Open a live shell session (SPEC §5). Returns the new `sessionId`; the shell
/// itself is driven on a background task and reports over `on_data` +
/// `session_status`. Async so the command runs on Tauri's tokio runtime, which
/// `spawn_session`'s `tokio::spawn` needs.
#[tauri::command]
pub async fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    device_id: String,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
) -> Result<String, AppError> {
    let device = find_device(&state, &device_id)?;
    let creds = resolve_credentials(&state, &device).await?;
    let session_id = Uuid::new_v4().to_string();
    let sink: Arc<dyn SessionSink> = Arc::new(TauriSessionSink {
        app,
        session_id: session_id.clone(),
        channel: Some(on_data),
    });
    state.session_manager.spawn_session(
        session_id.clone(),
        device.host,
        device.port,
        device.username,
        creds,
        cols,
        rows,
        sink,
    );
    Ok(session_id)
}

/// Forward keystrokes to a session (SPEC §5). Unknown/closed session ⇒ no-op.
#[tauri::command]
pub async fn write_stdin(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), AppError> {
    // Clone the `Arc` out so no managed-state guard is held across the `.await`.
    let manager = Arc::clone(&state.session_manager);
    manager.write_stdin(&session_id, data.into_bytes()).await;
    Ok(())
}

/// Resize a session's PTY (SPEC §5). Unknown/closed session ⇒ no-op.
#[tauri::command]
pub async fn resize_pty(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), AppError> {
    let manager = Arc::clone(&state.session_manager);
    manager.resize_pty(&session_id, cols, rows).await;
    Ok(())
}

/// Gracefully disconnect a session (SPEC §5). Idempotent: an unknown
/// `sessionId` is a no-op.
#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, session_id: String) -> Result<(), AppError> {
    let manager = Arc::clone(&state.session_manager);
    manager.disconnect(&session_id).await;
    Ok(())
}

/// Resolve a pending host-key trust prompt (SPEC §5). Unknown/stale prompt ⇒
/// no-op.
#[tauri::command]
pub fn respond_host_key(state: State<'_, AppState>, prompt_id: String, accept: bool) {
    state.session_manager.respond_host_key(&prompt_id, accept);
}

/// Connect + authenticate + close, no shell (SPEC §5). Surfaces the auth
/// outcome as `Ok(())` / `Err(AppError)`. Shares the host-key path, so a
/// first-contact test can raise a `host_key_prompt` like a live connect.
#[tauri::command]
pub async fn test_connection(
    app: AppHandle,
    state: State<'_, AppState>,
    device_id: String,
) -> Result<(), AppError> {
    let device = find_device(&state, &device_id)?;
    let creds = resolve_credentials(&state, &device).await?;
    let manager = Arc::clone(&state.session_manager);
    let sink: Arc<dyn SessionSink> = Arc::new(TauriSessionSink {
        app,
        session_id: format!("test-{device_id}"),
        channel: None,
    });
    manager
        .test_connection(device.host, device.port, device.username, creds, sink)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::Auth;
    use crate::known_hosts::KnownHostsStore;
    use crate::profile::{Grid, Pane};
    use crate::profile_store::ProfileStore;
    use crate::secret::InMemorySecretStore;
    use crate::session::SessionManager;
    use crate::settings::SettingsStore;
    use crate::store::DeviceStore;
    use tempfile::tempdir;

    fn test_state(dir: &std::path::Path) -> AppState {
        let known_hosts = Arc::new(KnownHostsStore::load(dir.to_path_buf()));
        AppState {
            device_store: DeviceStore::load(dir.to_path_buf()),
            profile_store: ProfileStore::load(dir.to_path_buf()),
            settings_store: SettingsStore::load(dir.to_path_buf()),
            secret_store: Arc::new(InMemorySecretStore::new()),
            session_manager: Arc::new(SessionManager::with_defaults(known_hosts)),
        }
    }

    fn sample_device() -> Device {
        Device {
            id: String::new(),
            name: "NAS".to_string(),
            host: "192.168.1.10".to_string(),
            port: 22,
            username: "admin".to_string(),
            auth: Auth::Password,
            auto_reconnect: false,
        }
    }

    #[test]
    fn save_device_with_secret_writes_it_to_the_secret_store() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());

        let saved = save_device_impl(&state, sample_device(), Some("hunter2".to_string())).unwrap();

        assert_eq!(
            state.secret_store.get(&saved.id).unwrap(),
            Some("hunter2".to_string())
        );
        assert_eq!(list_devices_impl(&state), vec![saved]);
    }

    #[test]
    fn save_device_without_secret_leaves_existing_secret_untouched() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());

        let saved = save_device_impl(&state, sample_device(), Some("hunter2".to_string())).unwrap();

        let mut edited = saved.clone();
        edited.name = "NAS renamed".to_string();
        let saved_again = save_device_impl(&state, edited, None).unwrap();

        assert_eq!(saved_again.name, "NAS renamed");
        assert_eq!(
            state.secret_store.get(&saved_again.id).unwrap(),
            Some("hunter2".to_string()),
            "secret must survive an update that doesn't include one"
        );
    }

    #[test]
    fn save_device_never_returns_secret_material() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let saved = save_device_impl(&state, sample_device(), Some("hunter2".to_string())).unwrap();

        // `Device` has no secret-shaped field at all, so this is really a
        // compile-time guarantee, but assert on the actual serialized
        // payload too, as a regression trip-wire for anyone tempted to add
        // one later.
        let value = serde_json::to_value(&saved).unwrap();
        let dump = value.to_string();
        assert!(!dump.contains("hunter2"));
    }

    #[test]
    fn save_device_validation_failure_does_not_write_a_secret() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let mut invalid = sample_device();
        invalid.name = String::new();

        let err = save_device_impl(&state, invalid, Some("hunter2".to_string())).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        assert!(list_devices_impl(&state).is_empty());
    }

    #[test]
    fn save_device_clears_stale_secret_when_auth_method_changes() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());

        // Start as a password device with a stored password.
        let saved = save_device_impl(&state, sample_device(), Some("hunter2".to_string())).unwrap();
        assert_eq!(
            state.secret_store.get(&saved.id).unwrap(),
            Some("hunter2".to_string())
        );

        // Edit it into a key device with a passphrase-less (unencrypted) key,
        // leaving the secret field empty ⇒ `secret: None`. The old password
        // must not survive as a phantom key passphrase (SPEC §4: a key device
        // with no passphrase has NO secret stored).
        let mut switched = saved.clone();
        switched.auth = Auth::Key {
            key_path: "C:/Users/x/.ssh/id_ed25519".to_string(),
        };
        let switched = save_device_impl(&state, switched, None).unwrap();

        assert_eq!(
            state.secret_store.get(&switched.id).unwrap(),
            None,
            "the old password must be cleared when the auth method changes"
        );
    }

    #[test]
    fn save_device_same_method_edit_without_secret_keeps_existing_secret() {
        // Guards against the auth-switch fix over-reaching: a same-method edit
        // that supplies no secret must still leave the stored secret intact.
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());

        let saved = save_device_impl(&state, sample_device(), Some("hunter2".to_string())).unwrap();

        let mut edited = saved.clone();
        edited.host = "10.0.0.1".to_string(); // still password auth
        let edited = save_device_impl(&state, edited, None).unwrap();

        assert_eq!(
            state.secret_store.get(&edited.id).unwrap(),
            Some("hunter2".to_string()),
            "a same-method edit with no secret must not disturb the keyring"
        );
    }

    #[test]
    fn delete_device_removes_device_and_its_secret() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let saved = save_device_impl(&state, sample_device(), Some("hunter2".to_string())).unwrap();

        delete_device_impl(&state, &saved.id).unwrap();

        assert!(list_devices_impl(&state).is_empty());
        assert_eq!(state.secret_store.get(&saved.id).unwrap(), None);
    }

    #[test]
    fn delete_device_unknown_id_is_not_found() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let err = delete_device_impl(&state, "does-not-exist").unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn delete_device_with_no_secret_ever_set_is_not_an_error() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let saved = save_device_impl(&state, sample_device(), None).unwrap();

        assert!(delete_device_impl(&state, &saved.id).is_ok());
    }

    #[tokio::test]
    async fn resolve_credentials_password_uses_stored_secret() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let saved = save_device_impl(&state, sample_device(), Some("hunter2".to_string())).unwrap();

        match resolve_credentials(&state, &saved).await.unwrap() {
            AuthCredentials::Password(pw) => assert_eq!(pw, "hunter2"),
            other => panic!("expected password credentials, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn resolve_credentials_password_missing_secret_is_ssh_auth() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        // Saved with no secret ⇒ nothing in the keyring for a password device.
        let saved = save_device_impl(&state, sample_device(), None).unwrap();

        let err = resolve_credentials(&state, &saved).await.unwrap_err();
        assert!(
            matches!(err, AppError::SshAuth(_)),
            "a password device with no stored secret must fail with SshAuth"
        );
        // The error text must not leak anything secret-shaped (there is none here,
        // but assert it points the user at the editor, per SPEC §6).
        if let AppError::SshAuth(msg) = err {
            assert!(msg.to_lowercase().contains("device editor"));
        }
    }

    #[tokio::test]
    async fn resolve_credentials_key_without_passphrase_is_unencrypted() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let mut device = sample_device();
        device.auth = Auth::Key {
            key_path: "C:/keys/id_ed25519".to_string(),
        };
        // No secret ⇒ unencrypted key (SPEC §4), NOT an error.
        let saved = save_device_impl(&state, device, None).unwrap();

        match resolve_credentials(&state, &saved).await.unwrap() {
            AuthCredentials::Key { path, passphrase } => {
                assert_eq!(path, "C:/keys/id_ed25519");
                assert_eq!(passphrase, None);
            }
            other => panic!("expected key credentials, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn resolve_credentials_key_with_passphrase_carries_it() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let mut device = sample_device();
        device.auth = Auth::Key {
            key_path: "C:/keys/id_ed25519".to_string(),
        };
        let saved = save_device_impl(&state, device, Some("phrase".to_string())).unwrap();

        match resolve_credentials(&state, &saved).await.unwrap() {
            AuthCredentials::Key { passphrase, .. } => {
                assert_eq!(passphrase, Some("phrase".to_string()));
            }
            other => panic!("expected key credentials, got {other:?}"),
        }
    }

    #[test]
    fn find_device_unknown_id_is_not_found() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let err = find_device(&state, "nope").unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    /* -- profile commands (SPEC.md §5, Phase 4) -------------------------- */

    fn profile_referencing(device_id: &str) -> Profile {
        Profile {
            id: String::new(),
            name: "Homelab".to_string(),
            grid: Grid {
                rows: 1,
                cols: 2,
                row_sizes: vec![1.0],
                col_sizes: vec![0.5, 0.5],
            },
            panes: vec![
                Pane {
                    device_id: Some(device_id.to_string()),
                },
                Pane { device_id: None },
            ],
        }
    }

    #[test]
    fn deleting_a_device_nulls_it_out_of_referencing_profiles() {
        // The command-level glue: delete_device must drive the profile-store
        // referential cleanup, not just the device/secret stores. (The store's
        // own clear_device logic is unit-tested in profile_store.rs; this
        // proves delete_device_impl actually calls it.)
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let device = save_device_impl(&state, sample_device(), Some("pw".to_string())).unwrap();
        let profile = save_profile_impl(&state, profile_referencing(&device.id)).unwrap();
        assert_eq!(
            state.profile_store.list().profiles[0].panes[0].device_id,
            Some(device.id.clone())
        );

        delete_device_impl(&state, &device.id).unwrap();

        let cleaned = state
            .profile_store
            .list()
            .profiles
            .into_iter()
            .find(|p| p.id == profile.id)
            .unwrap();
        assert_eq!(
            cleaned.panes[0].device_id, None,
            "the deleted device must be nulled out of the profile pane"
        );
    }

    #[test]
    fn profile_command_impls_round_trip_and_handle_default() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        assert!(list_profiles_impl(&state).profiles.is_empty());

        let saved = save_profile_impl(&state, profile_referencing("dev-1")).unwrap();
        set_default_profile_impl(&state, Some(saved.id.clone())).unwrap();
        let listed = list_profiles_impl(&state);
        assert_eq!(listed.profiles.len(), 1);
        assert_eq!(listed.default_profile_id, Some(saved.id.clone()));

        // Deleting the default profile clears the default (SPEC §5).
        delete_profile_impl(&state, &saved.id).unwrap();
        let after = list_profiles_impl(&state);
        assert!(after.profiles.is_empty());
        assert_eq!(after.default_profile_id, None);
    }
}
