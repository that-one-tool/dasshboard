//! Import/export of devices and profiles as self-describing JSON files
//! (PLAN-import-export.md). The frontend obtains a path from the native
//! dialog plugin; the `pub(crate)` `*_impl(&AppState, &Path)` functions here do
//! the actual file read/write and are what the `#[tauri::command]` wrappers in
//! `commands.rs` call. The JSON shaping is factored into pure (no-disk) helpers
//! so the envelope and validation logic can be unit-tested without touching the
//! filesystem.
//!
//! Security note: devices never carry secret material — `Device` has no
//! secret field (secrets live in the OS keyring, keyed by device id), so
//! exporting `Device`s structurally excludes all passwords/passphrases. The
//! export tests assert on the serialized bytes anyway, as a trip-wire.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::device::Device;
use crate::error::AppError;
use crate::profile::Profile;
use crate::state::AppState;

/// `kind` discriminant of a devices export file.
const DEVICES_KIND: &str = "dasshboard.devices";
/// `kind` discriminant of a profiles export file.
const PROFILES_KIND: &str = "dasshboard.profiles";
/// Envelope schema version written on export (reserved for future migrations;
/// import currently accepts any version).
const EXPORT_VERSION: u32 = 1;

/// Self-describing devices file: `{ kind, version, devices: [Device…] }`.
/// `Device` serializes exactly as it does in `devices.json` (camelCase,
/// tagged `auth`). `version` defaults on import so a hand-authored file that
/// omits it still loads; it is always written on export.
#[derive(Debug, Serialize, Deserialize)]
struct DevicesEnvelope {
    kind: String,
    #[serde(default)]
    version: u32,
    devices: Vec<Device>,
}

/// Self-describing profiles file: `{ kind, version, profiles: [Profile…] }`.
/// Deliberately has no `defaultProfileId` — the default is a per-machine
/// choice and is neither exported nor touched on import.
#[derive(Debug, Serialize, Deserialize)]
struct ProfilesEnvelope {
    kind: String,
    #[serde(default)]
    version: u32,
    profiles: Vec<Profile>,
}

/* ============================================================================
 * Pure helpers (no disk I/O) — the envelope + validation logic.
 * ============================================================================ */

/// Serialize devices into the pretty-printed export envelope. Serialization of
/// these plain structs is infallible in practice (no non-string map keys), so
/// the impossible error path falls back to an empty string rather than
/// panicking; the caller writes the result to the user-chosen path.
fn devices_to_export_json(devices: &[Device]) -> String {
    let envelope = DevicesEnvelope {
        kind: DEVICES_KIND.to_string(),
        version: EXPORT_VERSION,
        devices: devices.to_vec(),
    };
    serde_json::to_string_pretty(&envelope).unwrap_or_default()
}

/// Serialize profiles into the pretty-printed export envelope (see
/// [`devices_to_export_json`]).
fn profiles_to_export_json(profiles: &[Profile]) -> String {
    let envelope = ProfilesEnvelope {
        kind: PROFILES_KIND.to_string(),
        version: EXPORT_VERSION,
        profiles: profiles.to_vec(),
    };
    serde_json::to_string_pretty(&envelope).unwrap_or_default()
}

/// Parse + validate a devices import file. All-or-nothing: malformed JSON, a
/// wrong `kind`, or any single invalid device yields `AppError::Validation`
/// and no devices are returned (so the caller writes nothing). A serde parse
/// failure is mapped explicitly to `Validation` rather than going through the
/// `From<serde_json::Error>` → `Io` conversion, since a bad import file is a
/// validation problem, not a disk failure.
fn parse_devices_import(contents: &str) -> Result<Vec<Device>, AppError> {
    let envelope: DevicesEnvelope = serde_json::from_str(contents)
        .map_err(|e| AppError::Validation(format!("invalid devices file: {e}")))?;
    if envelope.kind != DEVICES_KIND {
        return Err(AppError::Validation(format!(
            "unexpected file kind {:?}; expected {DEVICES_KIND:?}",
            envelope.kind
        )));
    }
    for device in &envelope.devices {
        device.validate()?;
    }
    Ok(envelope.devices)
}

/// Parse + validate a profiles import file (see [`parse_devices_import`]).
fn parse_profiles_import(contents: &str) -> Result<Vec<Profile>, AppError> {
    let envelope: ProfilesEnvelope = serde_json::from_str(contents)
        .map_err(|e| AppError::Validation(format!("invalid profiles file: {e}")))?;
    if envelope.kind != PROFILES_KIND {
        return Err(AppError::Validation(format!(
            "unexpected file kind {:?}; expected {PROFILES_KIND:?}",
            envelope.kind
        )));
    }
    for profile in &envelope.profiles {
        profile.validate()?;
    }
    Ok(envelope.profiles)
}

/* ============================================================================
 * Impl functions (disk I/O) — testable with a hand-built AppState.
 * ============================================================================ */

/// Write all devices to `path` as the export envelope (pretty JSON,
/// overwriting any existing file). Returns the count written.
pub(crate) fn export_devices_impl(state: &AppState, path: &Path) -> Result<u32, AppError> {
    let devices = state.device_store.list();
    fs::write(path, devices_to_export_json(&devices))?;
    Ok(devices.len() as u32)
}

/// Read/validate/upsert devices from `path`. Every device is validated before
/// anything is written (all-or-nothing); each keeps its `id` (empty ⇒ a fresh
/// UUID, existing ⇒ replaced in place), so re-importing the same file is
/// idempotent. Returns the count imported.
pub(crate) fn import_devices_impl(state: &AppState, path: &Path) -> Result<u32, AppError> {
    let contents = fs::read_to_string(path)?;
    let devices = parse_devices_import(&contents)?;
    let count = devices.len() as u32;
    for device in devices {
        state.device_store.upsert(device)?;
    }
    Ok(count)
}

/// Write all profiles to `path` as the export envelope (excludes
/// `defaultProfileId`). Returns the count written.
pub(crate) fn export_profiles_impl(state: &AppState, path: &Path) -> Result<u32, AppError> {
    let profiles = state.profile_store.list().profiles;
    fs::write(path, profiles_to_export_json(&profiles))?;
    Ok(profiles.len() as u32)
}

/// Read/validate/upsert profiles from `path` (all-or-nothing, upsert by id).
/// Does not touch `defaultProfileId`. Returns the count imported.
pub(crate) fn import_profiles_impl(state: &AppState, path: &Path) -> Result<u32, AppError> {
    let contents = fs::read_to_string(path)?;
    let profiles = parse_profiles_import(&contents)?;
    let count = profiles.len() as u32;
    for profile in profiles {
        state.profile_store.upsert(profile)?;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use crate::device::{Auth, Connection, FlowControl, Parity};
    use crate::known_hosts::KnownHostsStore;
    use crate::profile::{Grid, Pane};
    use crate::profile_store::ProfileStore;
    use crate::secret::InMemorySecretStore;
    use crate::serial::SerialSessionManager;
    use crate::session::SessionManager;
    use crate::settings::SettingsStore;
    use crate::store::DeviceStore;
    use crate::tunnel::TunnelManager;
    use tempfile::tempdir;
    use uuid::Uuid;

    /// Same shape as the `commands.rs` test helper: a real (temp-dir-backed)
    /// store stack plus an in-memory keyring, no Tauri runtime required.
    fn test_state(dir: &std::path::Path) -> AppState {
        let known_hosts = Arc::new(KnownHostsStore::load(dir.to_path_buf()));
        let session_manager = Arc::new(SessionManager::with_defaults(known_hosts));
        let tunnel_manager = Arc::new(TunnelManager::with_defaults(session_manager.known_hosts()));
        let sftp_manager = Arc::new(crate::sftp::SftpManager::with_defaults(
            session_manager.known_hosts(),
        ));
        AppState {
            device_store: DeviceStore::load(dir.to_path_buf()),
            profile_store: ProfileStore::load(dir.to_path_buf()),
            settings_store: SettingsStore::load(dir.to_path_buf()),
            secret_store: Arc::new(InMemorySecretStore::new()),
            session_manager,
            tunnel_manager,
            sftp_manager,
            serial_manager: Arc::new(SerialSessionManager::new()),
        }
    }

    fn sample_device(name: &str) -> Device {
        Device {
            id: String::new(),
            name: name.to_string(),
            connection: Connection::Ssh {
                host: "192.168.1.10".to_string(),
                port: 22,
                username: "admin".to_string(),
                auth: Auth::Password,
                forwards: Vec::new(),
                tunnel_auto_start: false,
            },
            auto_reconnect: false,
        }
    }

    fn sample_serial_device(name: &str) -> Device {
        Device {
            id: String::new(),
            name: name.to_string(),
            connection: Connection::Serial {
                port_name: "COM3".to_string(),
                baud_rate: 115200,
                data_bits: 8,
                parity: Parity::None,
                stop_bits: 1,
                flow_control: FlowControl::None,
            },
            auto_reconnect: false,
        }
    }

    fn sample_profile(name: &str) -> Profile {
        Profile {
            id: String::new(),
            name: name.to_string(),
            grid: Grid {
                rows: 1,
                cols: 2,
                row_sizes: vec![1.0],
                col_sizes: vec![0.5, 0.5],
            },
            panes: vec![Pane { device_id: None }, Pane { device_id: None }],
        }
    }

    /* -- devices export ------------------------------------------------- */

    #[test]
    fn export_devices_writes_expected_envelope() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        state.device_store.upsert(sample_device("NAS")).unwrap();
        state.device_store.upsert(sample_device("Router")).unwrap();

        let out = dir.path().join("out.json");
        let count = export_devices_impl(&state, &out).unwrap();
        assert_eq!(count, 2);

        let raw = fs::read_to_string(&out).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["kind"], "dasshboard.devices");
        assert_eq!(value["version"], 1);
        assert_eq!(value["devices"].as_array().unwrap().len(), 2);
        // camelCase, tagged auth carried through from `Device`'s own serde.
        assert_eq!(
            value["devices"][0]["auth"],
            serde_json::json!({ "method": "password" })
        );
    }

    #[test]
    fn export_devices_contains_no_secret_shaped_content() {
        // `Device` has no secret field, so this is a structural guarantee; the
        // assertion is a regression trip-wire. Seed the keyring with a secret
        // to prove export never reaches into it.
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let saved = state.device_store.upsert(sample_device("NAS")).unwrap();
        state.secret_store.set(&saved.id, "hunter2").unwrap();

        let out = dir.path().join("out.json");
        export_devices_impl(&state, &out).unwrap();

        let raw = fs::read_to_string(&out).unwrap();
        assert!(
            !raw.contains("hunter2"),
            "export must never contain secret material"
        );
    }

    /* -- devices round-trip / upsert semantics -------------------------- */

    #[test]
    fn devices_round_trip_export_then_import_restores_them() {
        let src_dir = tempdir().unwrap();
        let src = test_state(src_dir.path());
        src.device_store.upsert(sample_device("NAS")).unwrap();
        src.device_store.upsert(sample_device("Router")).unwrap();
        let original = src.device_store.list();

        let file = src_dir.path().join("devices-export.json");
        export_devices_impl(&src, &file).unwrap();

        // Import into a completely fresh state (fresh dir ⇒ empty store).
        let dst_dir = tempdir().unwrap();
        let dst = test_state(dst_dir.path());
        let count = import_devices_impl(&dst, &file).unwrap();

        assert_eq!(count, 2);
        assert_eq!(dst.device_store.list(), original);
    }

    #[test]
    fn serial_devices_round_trip_export_then_import() {
        // A serial device must survive export→import exactly like an SSH one
        // (it carries no secret and no host/auth, only its framing params).
        let src_dir = tempdir().unwrap();
        let src = test_state(src_dir.path());
        src.device_store.upsert(sample_device("NAS")).unwrap();
        src.device_store
            .upsert(sample_serial_device("Arduino"))
            .unwrap();
        let original = src.device_store.list();

        let file = src_dir.path().join("mixed-export.json");
        export_devices_impl(&src, &file).unwrap();

        // The serial device's kind is carried through the envelope verbatim.
        let raw = fs::read_to_string(&file).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let serial = value["devices"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["name"] == "Arduino")
            .unwrap();
        assert_eq!(serial["kind"], "serial");
        assert_eq!(serial["portName"], "COM3");
        assert_eq!(serial["baudRate"], 115200);
        assert!(serial.get("host").is_none(), "serial carries no host");

        let dst_dir = tempdir().unwrap();
        let dst = test_state(dst_dir.path());
        let count = import_devices_impl(&dst, &file).unwrap();

        assert_eq!(count, 2);
        assert_eq!(dst.device_store.list(), original);
    }

    #[test]
    fn devices_import_preserves_ids_and_is_idempotent() {
        let src_dir = tempdir().unwrap();
        let src = test_state(src_dir.path());
        src.device_store.upsert(sample_device("NAS")).unwrap();
        let original = src.device_store.list();

        let file = src_dir.path().join("devices-export.json");
        export_devices_impl(&src, &file).unwrap();

        let dst_dir = tempdir().unwrap();
        let dst = test_state(dst_dir.path());
        import_devices_impl(&dst, &file).unwrap();
        // Second import of the same file must update in place, not duplicate.
        import_devices_impl(&dst, &file).unwrap();

        let after = dst.device_store.list();
        assert_eq!(after.len(), 1, "re-import must not create duplicates");
        assert_eq!(after, original, "ids and fields preserved across import");
    }

    #[test]
    fn device_with_empty_id_gets_a_fresh_uuidv4_on_import() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());

        // A file whose device carries an empty id (as a cross-machine or
        // hand-authored file might). Upsert must mint a fresh UUIDv4 for it.
        let json = devices_to_export_json(&[sample_device("NAS")]);
        assert!(
            json.contains("\"id\": \"\""),
            "fixture should carry an empty id"
        );
        let file = dir.path().join("in.json");
        fs::write(&file, json).unwrap();

        let count = import_devices_impl(&state, &file).unwrap();
        assert_eq!(count, 1);

        let imported = state.device_store.list();
        assert_eq!(imported.len(), 1);
        let parsed = Uuid::parse_str(&imported[0].id).expect("id should be a valid UUID");
        assert_eq!(parsed.get_version_num(), 4);
    }

    /* -- devices rejection: all-or-nothing ------------------------------ */

    #[test]
    fn devices_import_rejects_malformed_json_and_writes_nothing() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let file = dir.path().join("bad.json");
        fs::write(&file, "{ not valid json ").unwrap();

        let err = import_devices_impl(&state, &file).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        assert!(state.device_store.list().is_empty());
    }

    #[test]
    fn devices_import_rejects_wrong_kind_and_writes_nothing() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        // Structurally valid, but it's a profiles file fed to import_devices.
        let file = dir.path().join("wrong-kind.json");
        fs::write(
            &file,
            serde_json::json!({
                "kind": "dasshboard.profiles",
                "version": 1,
                "devices": []
            })
            .to_string(),
        )
        .unwrap();

        let err = import_devices_impl(&state, &file).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        assert!(state.device_store.list().is_empty());
    }

    #[test]
    fn devices_import_rejects_an_invalid_item_and_leaves_store_unchanged() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        // Pre-populate with one good device to prove a failed import is
        // all-or-nothing: the existing device must be untouched and the
        // valid item in the file must NOT be partially applied.
        let existing = state.device_store.upsert(sample_device("Keeper")).unwrap();

        let file = dir.path().join("has-invalid.json");
        fs::write(
            &file,
            serde_json::json!({
                "kind": "dasshboard.devices",
                "version": 1,
                "devices": [
                    { "id": "", "name": "Good", "host": "h", "port": 22,
                      "username": "u", "auth": { "method": "password" } },
                    { "id": "", "name": "", "host": "h", "port": 22,
                      "username": "u", "auth": { "method": "password" } }
                ]
            })
            .to_string(),
        )
        .unwrap();

        let err = import_devices_impl(&state, &file).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));

        let after = state.device_store.list();
        assert_eq!(after, vec![existing], "nothing from the file was applied");
    }

    /* -- profiles round-trip + default untouched ------------------------ */

    #[test]
    fn export_profiles_writes_expected_envelope_without_default() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        state
            .profile_store
            .upsert(sample_profile("Homelab"))
            .unwrap();

        let out = dir.path().join("out.json");
        let count = export_profiles_impl(&state, &out).unwrap();
        assert_eq!(count, 1);

        let raw = fs::read_to_string(&out).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["kind"], "dasshboard.profiles");
        assert_eq!(value["version"], 1);
        assert_eq!(value["profiles"].as_array().unwrap().len(), 1);
        assert!(
            value.get("defaultProfileId").is_none(),
            "profiles export must not include defaultProfileId"
        );
    }

    #[test]
    fn profiles_round_trip_export_then_import_restores_them() {
        let src_dir = tempdir().unwrap();
        let src = test_state(src_dir.path());
        src.profile_store.upsert(sample_profile("Homelab")).unwrap();
        src.profile_store.upsert(sample_profile("Office")).unwrap();
        let original = src.profile_store.list().profiles;

        let file = src_dir.path().join("profiles-export.json");
        export_profiles_impl(&src, &file).unwrap();

        let dst_dir = tempdir().unwrap();
        let dst = test_state(dst_dir.path());
        let count = import_profiles_impl(&dst, &file).unwrap();

        assert_eq!(count, 2);
        assert_eq!(dst.profile_store.list().profiles, original);
    }

    #[test]
    fn profiles_import_leaves_default_profile_id_untouched() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        // A local profile that is the current default.
        let local = state.profile_store.upsert(sample_profile("Local")).unwrap();
        state
            .profile_store
            .set_default(Some(local.id.clone()))
            .unwrap();

        // Import a different profile from a file.
        let other_dir = tempdir().unwrap();
        let other = test_state(other_dir.path());
        other
            .profile_store
            .upsert(sample_profile("Imported"))
            .unwrap();
        let file = other_dir.path().join("profiles-export.json");
        export_profiles_impl(&other, &file).unwrap();

        import_profiles_impl(&state, &file).unwrap();

        assert_eq!(
            state.profile_store.list().default_profile_id,
            Some(local.id),
            "import must not touch defaultProfileId"
        );
    }

    #[test]
    fn profiles_import_rejects_malformed_json_and_writes_nothing() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let file = dir.path().join("bad.json");
        fs::write(&file, "not json at all").unwrap();

        let err = import_profiles_impl(&state, &file).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        assert!(state.profile_store.list().profiles.is_empty());
    }

    #[test]
    fn profiles_import_rejects_wrong_kind_and_writes_nothing() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let file = dir.path().join("wrong-kind.json");
        fs::write(
            &file,
            serde_json::json!({
                "kind": "dasshboard.devices",
                "version": 1,
                "profiles": []
            })
            .to_string(),
        )
        .unwrap();

        let err = import_profiles_impl(&state, &file).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        assert!(state.profile_store.list().profiles.is_empty());
    }
}
