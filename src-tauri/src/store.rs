//! `DeviceStore` (SPEC.md §4): loads/saves `devices.json` with atomic
//! writes, recovering rather than crashing on a missing or corrupt file.
//!
//! Takes a directory path injected by the caller (not a hardcoded app
//! dir) so tests can point it at a temp dir (SPEC.md §10).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::device::Device;
use crate::error::AppError;

const DEVICES_FILE: &str = "devices.json";
const CURRENT_VERSION: u32 = 1;

/// On-disk shape of `devices.json` (SPEC.md §4).
#[derive(Debug, Serialize, Deserialize)]
struct DevicesFile {
    version: u32,
    devices: Vec<Device>,
}

pub struct DeviceStore {
    dir: PathBuf,
    devices: Mutex<Vec<Device>>,
}

impl DeviceStore {
    /// Loads `dir/devices.json`. Never panics and never returns an error to
    /// the caller:
    /// - missing file → empty store (the file is created on first save);
    /// - unreadable/corrupt file → the bad file is renamed to
    ///   `devices.json.corrupt-<unix-seconds>` (best effort; a failure to
    ///   back it up is logged, not fatal) and the store starts empty.
    ///
    /// Both recovery paths log a single line to stderr (never containing
    /// secret material — `devices.json` never holds secrets in the first
    /// place, per SPEC.md §4).
    pub fn load(dir: PathBuf) -> Self {
        let devices = Self::read_from_disk(&dir);
        DeviceStore {
            dir,
            devices: Mutex::new(devices),
        }
    }

    /// Re-reads `devices.json` from disk, replacing the in-memory list. Lets a
    /// second running app instance pick up devices another instance added,
    /// edited, or removed (each instance caches the file in memory at startup,
    /// so without this its view goes stale — see `reload_config`). Same
    /// recovery semantics as [`load`](Self::load): a missing file yields an
    /// empty list and a corrupt file is backed up and treated as empty.
    pub fn reload(&self) {
        let devices = Self::read_from_disk(&self.dir);
        *self.lock_devices() = devices;
    }

    /// Reads and parses `dir/devices.json` into a device list, applying the
    /// missing-file and corrupt-file recovery shared by `load` and `reload`.
    fn read_from_disk(dir: &Path) -> Vec<Device> {
        let path = dir.join(DEVICES_FILE);
        match fs::read_to_string(&path) {
            Ok(contents) => match serde_json::from_str::<DevicesFile>(&contents) {
                Ok(parsed) => parsed.devices,
                Err(err) => {
                    eprintln!(
                        "[DaSSHboard] devices.json is corrupt ({err}); backing it up and starting with an empty device list"
                    );
                    Self::backup_corrupt(&path);
                    Vec::new()
                }
            },
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(err) => {
                eprintln!(
                    "[DaSSHboard] could not read devices.json ({err}); backing it up and starting with an empty device list"
                );
                Self::backup_corrupt(&path);
                Vec::new()
            }
        }
    }

    fn backup_corrupt(path: &Path) {
        if !path.exists() {
            return;
        }
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let backup_path = path.with_file_name(format!("devices.json.corrupt-{timestamp}"));
        if let Err(err) = fs::rename(path, &backup_path) {
            eprintln!("[DaSSHboard] failed to back up corrupt devices.json: {err}");
        }
    }

    /// All devices, never including secret material (there is none in this
    /// struct to begin with — see `crate::secret`).
    pub fn list(&self) -> Vec<Device> {
        self.lock_devices().clone()
    }

    /// Upserts by `id`: an empty/blank `id` creates a new device with a
    /// fresh UUIDv4; a non-empty `id` matching an existing device replaces
    /// it in place; a non-empty `id` matching nothing creates it with that
    /// id. Validates before writing anything to disk.
    pub fn upsert(&self, mut device: Device) -> Result<Device, AppError> {
        if device.id.trim().is_empty() {
            device.id = Uuid::new_v4().to_string();
        }
        device.validate()?;

        // Persist-then-commit: build the new list in a local `candidate` and
        // only swap it into the guarded state once `persist()` has actually
        // succeeded, so a write failure never leaves memory diverged from
        // disk (the guard stays untouched on error).
        let mut guard = self.lock_devices();
        let mut candidate = guard.clone();
        match candidate.iter_mut().find(|d| d.id == device.id) {
            Some(existing) => *existing = device.clone(),
            None => candidate.push(device.clone()),
        }
        self.persist(&candidate)?;
        *guard = candidate;
        Ok(device)
    }

    /// Removes the device with the given id. Returns `AppError::NotFound`
    /// if no device with that id exists.
    pub fn delete(&self, id: &str) -> Result<(), AppError> {
        let mut guard = self.lock_devices();
        let index = guard
            .iter()
            .position(|d| d.id == id)
            .ok_or_else(|| AppError::NotFound(format!("device '{id}' not found")))?;
        // Persist-then-commit (see `upsert`): mutate a local copy, persist
        // it, then swap it in only on success.
        let mut candidate = guard.clone();
        candidate.remove(index);
        self.persist(&candidate)?;
        *guard = candidate;
        Ok(())
    }

    fn lock_devices(&self) -> std::sync::MutexGuard<'_, Vec<Device>> {
        self.devices
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Atomic write: serialize to a temp file in the same directory, then
    /// `rename` over the real file. `rename` within one directory is atomic
    /// on both Windows and POSIX filesystems, so readers only ever see the
    /// fully-old or fully-new content, never a partial write.
    fn persist(&self, devices: &[Device]) -> Result<(), AppError> {
        fs::create_dir_all(&self.dir)?;
        let file = DevicesFile {
            version: CURRENT_VERSION,
            devices: devices.to_vec(),
        };
        let json = serde_json::to_string_pretty(&file)?;
        let tmp_path = self
            .dir
            .join(format!("{DEVICES_FILE}.tmp-{}", Uuid::new_v4()));
        fs::write(&tmp_path, json)?;
        fs::rename(&tmp_path, self.dir.join(DEVICES_FILE))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::{Auth, Connection};
    use tempfile::tempdir;

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

    #[test]
    fn missing_file_yields_empty_store() {
        let dir = tempdir().unwrap();
        let store = DeviceStore::load(dir.path().to_path_buf());
        assert!(store.list().is_empty());
        // No file should have been created just by loading.
        assert!(!dir.path().join(DEVICES_FILE).exists());
    }

    #[test]
    fn crud_round_trip_persists_across_loads() {
        let dir = tempdir().unwrap();
        let store = DeviceStore::load(dir.path().to_path_buf());
        let saved = store.upsert(sample_device("NAS")).unwrap();
        assert!(!saved.id.is_empty());
        assert_eq!(store.list(), vec![saved.clone()]);

        // Reload from disk into a fresh store to prove persistence, not just
        // in-memory state.
        let reloaded = DeviceStore::load(dir.path().to_path_buf());
        assert_eq!(reloaded.list(), vec![saved]);
    }

    #[test]
    fn upsert_with_empty_id_generates_a_valid_uuidv4() {
        let dir = tempdir().unwrap();
        let store = DeviceStore::load(dir.path().to_path_buf());
        let saved = store.upsert(sample_device("NAS")).unwrap();
        let parsed = Uuid::parse_str(&saved.id).expect("id should be a valid UUID");
        assert_eq!(parsed.get_version_num(), 4);
    }

    #[test]
    fn upsert_with_existing_id_replaces_in_place_not_append() {
        let dir = tempdir().unwrap();
        let store = DeviceStore::load(dir.path().to_path_buf());
        let saved = store.upsert(sample_device("NAS")).unwrap();

        let mut updated = saved.clone();
        updated.name = "NAS renamed".to_string();
        let saved_again = store.upsert(updated.clone()).unwrap();

        assert_eq!(saved_again.id, saved.id);
        let all = store.list();
        assert_eq!(all.len(), 1, "upsert must replace, not duplicate");
        assert_eq!(all[0].name, "NAS renamed");
    }

    #[test]
    fn upsert_with_unknown_nonempty_id_creates_with_that_id() {
        let dir = tempdir().unwrap();
        let store = DeviceStore::load(dir.path().to_path_buf());
        let mut device = sample_device("NAS");
        device.id = "11111111-1111-4111-8111-111111111111".to_string();
        let saved = store.upsert(device).unwrap();
        assert_eq!(saved.id, "11111111-1111-4111-8111-111111111111");
        assert_eq!(store.list().len(), 1);
    }

    #[test]
    fn delete_removes_device() {
        let dir = tempdir().unwrap();
        let store = DeviceStore::load(dir.path().to_path_buf());
        let saved = store.upsert(sample_device("NAS")).unwrap();
        store.delete(&saved.id).unwrap();
        assert!(store.list().is_empty());
    }

    #[test]
    fn delete_unknown_id_returns_not_found() {
        let dir = tempdir().unwrap();
        let store = DeviceStore::load(dir.path().to_path_buf());
        let err = store.delete("does-not-exist").unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn validation_rejection_does_not_touch_disk() {
        let dir = tempdir().unwrap();
        let store = DeviceStore::load(dir.path().to_path_buf());
        let mut invalid = sample_device("NAS");
        invalid.name = String::new();

        let err = store.upsert(invalid).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        assert!(store.list().is_empty());
        assert!(
            !dir.path().join(DEVICES_FILE).exists(),
            "a rejected upsert must not create devices.json"
        );
    }

    #[test]
    fn atomic_write_leaves_no_leftover_temp_file_and_valid_content() {
        let dir = tempdir().unwrap();
        let store = DeviceStore::load(dir.path().to_path_buf());
        store.upsert(sample_device("NAS")).unwrap();
        store.upsert(sample_device("Router")).unwrap();

        let entries: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            entries,
            vec![DEVICES_FILE.to_string()],
            "only the final devices.json should remain — no dangling .tmp- files"
        );

        let raw = fs::read_to_string(dir.path().join(DEVICES_FILE)).unwrap();
        let parsed: DevicesFile = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed.version, 1);
        assert_eq!(parsed.devices.len(), 2);
    }

    #[test]
    fn a_stray_leftover_temp_file_does_not_break_loading() {
        // Simulates a crash between the temp-write and the rename in a
        // previous process: a `.tmp-*` file sits next to a valid
        // devices.json. Loading must only ever consider devices.json.
        let dir = tempdir().unwrap();
        let store = DeviceStore::load(dir.path().to_path_buf());
        let saved = store.upsert(sample_device("NAS")).unwrap();
        fs::write(dir.path().join("devices.json.tmp-leftover"), "not json").unwrap();

        let reloaded = DeviceStore::load(dir.path().to_path_buf());
        assert_eq!(reloaded.list(), vec![saved]);
    }

    #[test]
    fn corrupt_file_is_backed_up_and_store_starts_empty() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(DEVICES_FILE), "{ not valid json ").unwrap();

        let store = DeviceStore::load(dir.path().to_path_buf());
        assert!(store.list().is_empty());

        // Original corrupt file is gone from its original path...
        assert!(!dir.path().join(DEVICES_FILE).exists());

        // ...and a backup with the expected naming pattern exists containing
        // the original (corrupt) content, so nothing was silently destroyed.
        let backups: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("devices.json.corrupt-"))
            .collect();
        assert_eq!(backups.len(), 1, "expected exactly one backup file");
        let backup_content = fs::read_to_string(dir.path().join(&backups[0])).unwrap();
        assert_eq!(backup_content, "{ not valid json ");

        // The store is still usable afterward: saving now creates a fresh,
        // valid devices.json alongside the backup.
        store.upsert(sample_device("NAS")).unwrap();
        assert!(dir.path().join(DEVICES_FILE).exists());
    }

    // -- B1: persist failure must not diverge memory from disk ------------

    /// Forces the store's next `persist()` to fail: replaces the store's
    /// target directory with a plain file, so `fs::create_dir_all` inside
    /// `persist` errors instead of silently no-op'ing. Chosen over toggling
    /// OS permission bits because read-only directories behave
    /// inconsistently across platforms (notably Windows); "a file sits where
    /// a directory is expected" fails deterministically everywhere.
    fn block_store_dir_with_a_file(dir: &Path) {
        if dir.is_dir() {
            fs::remove_dir_all(dir).unwrap();
        }
        fs::write(dir, "blocking file").unwrap();
    }

    #[test]
    fn upsert_leaves_memory_unchanged_when_persist_fails() {
        let root = tempdir().unwrap();
        let store_dir = root.path().join("store");
        block_store_dir_with_a_file(&store_dir);
        let store = DeviceStore::load(store_dir);

        let err = store.upsert(sample_device("NAS")).unwrap_err();
        assert!(matches!(err, AppError::Io(_)));
        assert!(
            store.list().is_empty(),
            "a failed persist must not leave the upsert applied in memory"
        );
    }

    #[test]
    fn delete_leaves_memory_unchanged_when_persist_fails() {
        let root = tempdir().unwrap();
        let store_dir = root.path().join("store");
        let store = DeviceStore::load(store_dir.clone());
        let saved = store.upsert(sample_device("NAS")).unwrap();

        block_store_dir_with_a_file(&store_dir);

        let err = store.delete(&saved.id).unwrap_err();
        assert!(matches!(err, AppError::Io(_)));
        assert_eq!(
            store.list(),
            vec![saved],
            "a failed persist must not leave the delete applied in memory"
        );
    }

    #[test]
    fn wire_format_wrapper_matches_spec_shape() {
        let dir = tempdir().unwrap();
        let store = DeviceStore::load(dir.path().to_path_buf());
        store.upsert(sample_device("NAS")).unwrap();

        let raw = fs::read_to_string(dir.path().join(DEVICES_FILE)).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["version"], 1);
        assert!(value["devices"].is_array());
        assert_eq!(
            value["devices"][0]["auth"],
            serde_json::json!({ "method": "password" })
        );
    }

    // -- reload: multi-instance sync (pick up another instance's writes) ----

    #[test]
    fn reload_picks_up_a_change_written_by_another_instance() {
        let dir = tempdir().unwrap();
        // This instance's store, holding one device in memory.
        let store = DeviceStore::load(dir.path().to_path_buf());
        store.upsert(sample_device("NAS")).unwrap();
        assert_eq!(store.list().len(), 1);

        // A *second* instance (same config dir) adds another device, rewriting
        // devices.json on disk. Our in-memory store is now stale.
        let other = DeviceStore::load(dir.path().to_path_buf());
        other.upsert(sample_device("Router")).unwrap();
        assert_eq!(store.list().len(), 1, "must stay stale until reloaded");

        store.reload();

        let names: Vec<String> = store.list().into_iter().map(|d| d.name).collect();
        assert_eq!(names.len(), 2);
        assert!(names.contains(&"NAS".to_string()));
        assert!(names.contains(&"Router".to_string()));
    }

    #[test]
    fn reload_recovers_to_empty_when_the_file_disappears() {
        let dir = tempdir().unwrap();
        let store = DeviceStore::load(dir.path().to_path_buf());
        store.upsert(sample_device("NAS")).unwrap();

        fs::remove_file(dir.path().join(DEVICES_FILE)).unwrap();
        store.reload();

        assert!(store.list().is_empty());
    }

    #[test]
    fn reload_backs_up_a_corrupt_file_and_empties_the_store() {
        let dir = tempdir().unwrap();
        let store = DeviceStore::load(dir.path().to_path_buf());
        store.upsert(sample_device("NAS")).unwrap();

        // Another process (or disk gremlin) corrupts the file under us.
        fs::write(dir.path().join(DEVICES_FILE), "{ not json ").unwrap();
        store.reload();

        assert!(store.list().is_empty());
        let backups = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("devices.json.corrupt-")
            })
            .count();
        assert_eq!(backups, 1, "a corrupt file must be backed up on reload too");
    }
}
