//! Device CRUD: the keyring write comes first, so a failed secret write never
//! leaves a device on disk claiming credentials it has no secret for.

use tauri::State;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

use crate::device::Device;
use crate::error::AppError;
use crate::state::AppState;

pub(super) fn list_devices_impl(state: &AppState) -> Vec<Device> {
    state.device_store.list()
}

/// Writes/clears the keyring entry for a save (B2 fix: this runs *before*
/// the device is persisted, so a keyring failure never leaves `devices.json`
/// claiming an auth method with no matching credential — see
/// `save_device_impl`).
///
/// `secret: Some` writes it verbatim. `secret: None` usually means "leave the
/// existing keyring entry untouched" (the common edit case behind SPEC §7's
/// "unchanged" placeholder); but if the auth method just changed, any stored
/// secret belongs to the *old* method — a password is not a key passphrase
/// and vice versa — so it's deleted instead, per SPEC §4's rule that a `key`
/// device with no passphrase has NO secret stored.
fn write_secret_for_save(
    state: &AppState,
    device_id: &str,
    previous_method: Option<&'static str>,
    incoming_method: &'static str,
    secret: Option<&str>,
) -> Result<(), AppError> {
    match secret {
        Some(secret) => state.secret_store.set(device_id, secret),
        None if previous_method.is_some_and(|prev| prev != incoming_method) => {
            state.secret_store.delete(device_id)
        }
        None => Ok(()),
    }
}

pub(super) fn save_device_impl(
    state: &AppState,
    mut device: Device,
    secret: Option<String>,
) -> Result<Device, AppError> {
    // Assign the id up front (mirrors `DeviceStore::upsert`'s own id
    // assignment, which is then a no-op) so the secret can be written under
    // the device's final id *before* anything is persisted to devices.json.
    if device.id.trim().is_empty() {
        device.id = Uuid::new_v4().to_string();
    }
    device.validate()?;

    // A serial or local-shell device has NO secret (SPEC §4): never store one,
    // even if the frontend erroneously supplied it. Dropping it here also means
    // the ssh→serial/local edit path below sees the method change and clears any
    // stale password/passphrase left over from when the device was SSH.
    let mut secret = Zeroizing::new(secret);
    if !device.has_secret() {
        secret.zeroize();
    }

    // Capture the previously-stored secret "slot" (SSH auth method, or "serial")
    // if this is an edit of an existing device, before anything below changes
    // it, so we can tell whether the slot is changing.
    let previous_method = state
        .device_store
        .list()
        .into_iter()
        .find(|d| d.id == device.id)
        .map(|d| d.secret_method());
    let incoming_method = device.secret_method();

    // B2: write the secret first. If the keyring write fails, we return here
    // and `device_store.upsert` never runs, so a device can never end up on
    // disk claiming an auth method with no matching keyring entry.
    write_secret_for_save(
        state,
        &device.id,
        previous_method,
        incoming_method,
        secret.as_deref(),
    )?;

    state.device_store.upsert(device)
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
    // Also null this device out of any OTHER device's `proxyJump` (ProxyJump),
    // so no saved device is left jumping through a host that no longer exists.
    let device_ref_res = state.device_store.clear_proxy_jump(device_id);
    // B4: `secret_res?` below returns first on a double failure, which would
    // otherwise silently discard the other errors. Log any that won't be
    // returned so a multi-failure cleanup isn't invisible (matches the non-fatal
    // `eprintln!` pattern used elsewhere in the stores).
    if secret_res.is_err() || profile_res.is_err() || device_ref_res.is_err() {
        eprintln!(
            "[DaSSHboard] delete_device({device_id}) cleanup: keyring={secret_res:?}, profiles={profile_res:?}, proxyJump refs={device_ref_res:?} (only the first error is returned to the caller)"
        );
    }
    secret_res?;
    profile_res?;
    device_ref_res?;
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::profiles::save_profile_impl;
    use crate::commands::test_support::*;
    use crate::device::{Auth, Connection};
    use crate::secret::FailingSecretStore;
    use std::sync::Arc;
    use tempfile::tempdir;

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
        set_ssh_auth(
            &mut switched,
            Auth::Key {
                key_path: "C:/Users/x/.ssh/id_ed25519".to_string(),
            },
        );
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
        set_ssh_host(&mut edited, "10.0.0.1"); // still password auth
        let edited = save_device_impl(&state, edited, None).unwrap();

        assert_eq!(
            state.secret_store.get(&edited.id).unwrap(),
            Some("hunter2".to_string()),
            "a same-method edit with no secret must not disturb the keyring"
        );
    }

    #[test]
    fn save_serial_device_never_stores_a_secret() {
        // A serial device has no secret (SPEC §4). Even if a secret is supplied
        // (e.g. a frontend bug), nothing must land in the keyring for its id.
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());

        let saved =
            save_device_impl(&state, sample_serial_device(), Some("nope".to_string())).unwrap();

        assert!(saved.is_serial());
        assert_eq!(state.secret_store.get(&saved.id).unwrap(), None);
    }

    #[test]
    fn switching_ssh_to_serial_clears_the_old_secret() {
        // Editing a password SSH device into a serial one must clear the now-
        // meaningless stored password (the "slot" changed password → serial).
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());

        let saved = save_device_impl(&state, sample_device(), Some("hunter2".to_string())).unwrap();
        assert_eq!(
            state.secret_store.get(&saved.id).unwrap(),
            Some("hunter2".to_string())
        );

        let mut switched = saved.clone();
        switched.connection = Connection::Serial {
            port_name: "COM3".to_string(),
            baud_rate: 9600,
            data_bits: 8,
            parity: crate::device::Parity::None,
            stop_bits: 1,
            flow_control: crate::device::FlowControl::None,
        };
        let switched = save_device_impl(&state, switched, None).unwrap();

        assert!(switched.is_serial());
        assert_eq!(
            state.secret_store.get(&switched.id).unwrap(),
            None,
            "the old password must be cleared when switching to a serial device"
        );
    }

    // -- B2: secret-write failure must not leave an orphaned device -------

    #[test]
    fn save_device_does_not_persist_device_when_secret_write_fails() {
        let dir = tempdir().unwrap();
        let secret_store = Arc::new(FailingSecretStore::new());
        secret_store.fail_next_set();
        let state = test_state_with_secret_store(dir.path(), secret_store);

        let err =
            save_device_impl(&state, sample_device(), Some("hunter2".to_string())).unwrap_err();

        assert!(matches!(err, AppError::Keyring(_)));
        assert!(
            list_devices_impl(&state).is_empty(),
            "a device must not be persisted claiming a credential that failed to write"
        );
    }

    #[test]
    fn save_device_edit_does_not_persist_when_secret_write_fails() {
        // Same as above, but for an edit of an already-saved device: the
        // pre-existing on-disk device must be left exactly as it was.
        let dir = tempdir().unwrap();
        let secret_store = Arc::new(FailingSecretStore::new());
        let state = test_state_with_secret_store(
            dir.path(),
            Arc::clone(&secret_store) as Arc<dyn crate::secret::SecretStore>,
        );
        let saved = save_device_impl(&state, sample_device(), Some("hunter2".to_string())).unwrap();

        let mut edited = saved.clone();
        set_ssh_host(&mut edited, "10.0.0.1");
        secret_store.fail_next_set();

        let err = save_device_impl(&state, edited, Some("newpass".to_string())).unwrap_err();

        assert!(matches!(err, AppError::Keyring(_)));
        assert_eq!(
            list_devices_impl(&state),
            vec![saved],
            "a failed secret write must leave the previously-saved device untouched"
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

    // -- B4: a double cleanup failure must still return the keyring error --

    #[test]
    fn delete_device_returns_keyring_error_when_secret_delete_fails() {
        // Regression coverage for B4: even when both cleanups are attempted,
        // the caller must still see the (first) keyring error rather than it
        // being swallowed. The profile-cleanup error being dropped in that
        // case is a deliberate, logged trade-off (see the `eprintln!` in
        // `delete_device_impl`), not something a test can assert on stderr,
        // so this test only pins the still-returned error.
        let dir = tempdir().unwrap();
        let secret_store = Arc::new(FailingSecretStore::new());
        secret_store.fail_next_delete();
        let state = test_state_with_secret_store(
            dir.path(),
            Arc::clone(&secret_store) as Arc<dyn crate::secret::SecretStore>,
        );
        let saved = save_device_impl(&state, sample_device(), Some("hunter2".to_string())).unwrap();

        let err = delete_device_impl(&state, &saved.id).unwrap_err();

        assert!(matches!(err, AppError::Keyring(_)));
        // The device itself is still gone — cleanup failures don't resurrect it.
        assert!(list_devices_impl(&state).is_empty());
    }

    #[test]
    fn delete_device_with_no_secret_ever_set_is_not_an_error() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let saved = save_device_impl(&state, sample_device(), None).unwrap();

        assert!(delete_device_impl(&state, &saved.id).is_ok());
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
            state.profile_store.list().profiles[0].tabs[0].panes[0].device_id,
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
            cleaned.tabs[0].panes[0].device_id, None,
            "the deleted device must be nulled out of the profile pane"
        );
    }
}
