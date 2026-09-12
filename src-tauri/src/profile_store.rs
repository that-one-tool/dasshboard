//! `ProfileStore` (SPEC.md §4): loads/saves `profiles.json` with atomic
//! writes, recovering rather than crashing on a missing or corrupt file.
//! Mirrors `DeviceStore` (see `store.rs`) closely — same load/backup/persist
//! shape — plus the profile-specific `defaultProfileId` bookkeeping and the
//! device-deletion referential-cleanup method used by `delete_device`
//! (PLAN.md Phase 4 task 4).
//!
//! Takes a directory path injected by the caller (not a hardcoded app dir)
//! so tests can point it at a temp dir (SPEC.md §10).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::atomic_file;
use crate::error::AppError;
use crate::profile::Profile;

const PROFILES_FILE: &str = "profiles.json";
const CURRENT_VERSION: u32 = 1;

/// On-disk shape of `profiles.json` (SPEC.md §4).
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfilesFile {
    version: u32,
    default_profile_id: Option<String>,
    profiles: Vec<Profile>,
}

/// Return shape of `list_profiles` (SPEC.md §5): `{ defaultProfileId, profiles }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileList {
    pub default_profile_id: Option<String>,
    pub profiles: Vec<Profile>,
}

struct ProfilesState {
    default_profile_id: Option<String>,
    profiles: Vec<Profile>,
}

pub struct ProfileStore {
    dir: PathBuf,
    state: Mutex<ProfilesState>,
}

impl ProfileStore {
    /// Loads `dir/profiles.json`. Never panics and never returns an error to
    /// the caller:
    /// - missing file → empty store, `defaultProfileId: None` (the file is
    ///   created on first save);
    /// - unreadable/corrupt file → the bad file is renamed to
    ///   `profiles.json.corrupt-<unix-seconds>` (best effort; a failure to
    ///   back it up is logged, not fatal) and the store starts empty.
    pub fn load(dir: PathBuf) -> Self {
        let state = Self::read_from_disk(&dir);
        ProfileStore {
            dir,
            state: Mutex::new(state),
        }
    }

    /// Re-reads `profiles.json` from disk, replacing the in-memory profile list
    /// and default id. Lets a second running app instance pick up profiles
    /// another instance saved, renamed, or deleted (see `reload_config`). Same
    /// recovery semantics as [`load`](Self::load).
    pub fn reload(&self) {
        let state = Self::read_from_disk(&self.dir);
        *self.lock_state() = state;
    }

    /// Reads and parses `dir/profiles.json` into a [`ProfilesState`], applying
    /// the missing-file and corrupt-file recovery shared by `load` and `reload`
    /// (see [`atomic_file::read_recovering`]).
    fn read_from_disk(dir: &Path) -> ProfilesState {
        atomic_file::read_recovering::<ProfilesFile, _>(
            dir,
            PROFILES_FILE,
            |file| ProfilesState {
                default_profile_id: file.default_profile_id,
                profiles: file.profiles,
            },
            || ProfilesState {
                default_profile_id: None,
                profiles: Vec::new(),
            },
        )
    }

    /// All profiles plus the current default id (SPEC.md §5 `list_profiles`).
    pub fn list(&self) -> ProfileList {
        let state = self.lock_state();
        ProfileList {
            default_profile_id: state.default_profile_id.clone(),
            profiles: state.profiles.clone(),
        }
    }

    /// Upserts by `id`: an empty/blank `id` creates a new profile with a
    /// fresh UUIDv4; a non-empty `id` matching an existing profile replaces
    /// it in place; a non-empty `id` matching nothing creates it with that
    /// id (mirrors `DeviceStore::upsert`). Validates before writing anything
    /// to disk.
    pub fn upsert(&self, mut profile: Profile) -> Result<Profile, AppError> {
        if profile.id.trim().is_empty() {
            profile.id = Uuid::new_v4().to_string();
        }
        profile.validate()?;

        // Persist-then-commit (mirrors `DeviceStore::upsert`): mutate a local
        // copy of the profile list, persist it, and only swap it into the
        // guarded state once `persist()` succeeds.
        let mut guard = self.lock_state();
        let mut profiles = guard.profiles.clone();
        match profiles.iter_mut().find(|p| p.id == profile.id) {
            Some(existing) => *existing = profile.clone(),
            None => profiles.push(profile.clone()),
        }
        let candidate = ProfilesState {
            default_profile_id: guard.default_profile_id.clone(),
            profiles,
        };
        self.persist(&candidate)?;
        *guard = candidate;
        Ok(profile)
    }

    /// Removes the profile with the given id. Returns `AppError::NotFound` if
    /// no profile with that id exists. If the deleted profile was the
    /// default, `defaultProfileId` is cleared to `null` (SPEC.md §5) so it
    /// never dangles.
    pub fn delete(&self, id: &str) -> Result<(), AppError> {
        let mut guard = self.lock_state();
        let index = guard
            .profiles
            .iter()
            .position(|p| p.id == id)
            .ok_or_else(|| AppError::NotFound(format!("profile '{id}' not found")))?;

        // Persist-then-commit (see `upsert`).
        let mut profiles = guard.profiles.clone();
        profiles.remove(index);
        let default_profile_id = if guard.default_profile_id.as_deref() == Some(id) {
            None
        } else {
            guard.default_profile_id.clone()
        };
        let candidate = ProfilesState {
            default_profile_id,
            profiles,
        };
        self.persist(&candidate)?;
        *guard = candidate;
        Ok(())
    }

    /// Sets (or clears, with `None`) the default profile id. Decision: a
    /// `Some(id)` that doesn't match any stored profile is rejected with
    /// `AppError::NotFound` rather than silently stored as a dangling
    /// reference — the frontend flow always saves a profile before pointing
    /// the default at it, so there's no legitimate case for setting a
    /// default to an id that doesn't exist yet.
    pub fn set_default(&self, profile_id: Option<String>) -> Result<(), AppError> {
        let mut guard = self.lock_state();
        if let Some(id) = &profile_id {
            if !guard.profiles.iter().any(|p| &p.id == id) {
                return Err(AppError::NotFound(format!("profile '{id}' not found")));
            }
        }
        // Persist-then-commit (see `upsert`).
        let candidate = ProfilesState {
            default_profile_id: profile_id,
            profiles: guard.profiles.clone(),
        };
        self.persist(&candidate)?;
        *guard = candidate;
        Ok(())
    }

    /// Referential cleanup used by `delete_device` (PLAN.md Phase 4 task 4):
    /// nulls out `panes[].deviceId` for every pane across every profile that
    /// references `device_id`. Only persists if something actually changed,
    /// so deleting a device that no profile references doesn't rewrite
    /// `profiles.json` (or create it) needlessly.
    pub fn clear_device(&self, device_id: &str) -> Result<(), AppError> {
        let mut guard = self.lock_state();
        let mut profiles = guard.profiles.clone();
        let mut changed = false;
        for profile in profiles.iter_mut() {
            for pane in profile.panes.iter_mut() {
                if pane.device_id.as_deref() == Some(device_id) {
                    pane.device_id = None;
                    changed = true;
                }
            }
        }
        if changed {
            // Persist-then-commit (see `upsert`).
            let candidate = ProfilesState {
                default_profile_id: guard.default_profile_id.clone(),
                profiles,
            };
            self.persist(&candidate)?;
            *guard = candidate;
        }
        Ok(())
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, ProfilesState> {
        atomic_file::lock(&self.state)
    }

    /// Atomically persists the whole profile state (see
    /// [`atomic_file::write_json`]).
    fn persist(&self, state: &ProfilesState) -> Result<(), AppError> {
        let file = ProfilesFile {
            version: CURRENT_VERSION,
            default_profile_id: state.default_profile_id.clone(),
            profiles: state.profiles.clone(),
        };
        atomic_file::write_json(&self.dir, PROFILES_FILE, &file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::{Grid, Pane};
    use std::fs;
    use tempfile::tempdir;

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

    fn sample_profile_with_devices(name: &str, device_ids: [Option<&str>; 2]) -> Profile {
        Profile {
            panes: device_ids
                .into_iter()
                .map(|id| Pane {
                    device_id: id.map(str::to_string),
                })
                .collect(),
            ..sample_profile(name)
        }
    }

    #[test]
    fn missing_file_yields_empty_store() {
        let dir = tempdir().unwrap();
        let store = ProfileStore::load(dir.path().to_path_buf());
        let list = store.list();
        assert!(list.profiles.is_empty());
        assert_eq!(list.default_profile_id, None);
        // No file should have been created just by loading.
        assert!(!dir.path().join(PROFILES_FILE).exists());
    }

    #[test]
    fn crud_round_trip_persists_across_loads() {
        let dir = tempdir().unwrap();
        let store = ProfileStore::load(dir.path().to_path_buf());
        let saved = store.upsert(sample_profile("Homelab")).unwrap();
        assert!(!saved.id.is_empty());
        assert_eq!(store.list().profiles, vec![saved.clone()]);

        // Reload from disk into a fresh store to prove persistence, not just
        // in-memory state.
        let reloaded = ProfileStore::load(dir.path().to_path_buf());
        assert_eq!(reloaded.list().profiles, vec![saved]);
    }

    #[test]
    fn upsert_with_empty_id_generates_a_valid_uuidv4() {
        let dir = tempdir().unwrap();
        let store = ProfileStore::load(dir.path().to_path_buf());
        let saved = store.upsert(sample_profile("Homelab")).unwrap();
        let parsed = Uuid::parse_str(&saved.id).expect("id should be a valid UUID");
        assert_eq!(parsed.get_version_num(), 4);
    }

    #[test]
    fn upsert_with_existing_id_replaces_in_place_not_append() {
        let dir = tempdir().unwrap();
        let store = ProfileStore::load(dir.path().to_path_buf());
        let saved = store.upsert(sample_profile("Homelab")).unwrap();

        let mut updated = saved.clone();
        updated.name = "Homelab renamed".to_string();
        let saved_again = store.upsert(updated).unwrap();

        assert_eq!(saved_again.id, saved.id);
        let all = store.list().profiles;
        assert_eq!(all.len(), 1, "upsert must replace, not duplicate");
        assert_eq!(all[0].name, "Homelab renamed");
    }

    #[test]
    fn upsert_with_unknown_nonempty_id_creates_with_that_id() {
        let dir = tempdir().unwrap();
        let store = ProfileStore::load(dir.path().to_path_buf());
        let mut profile = sample_profile("Homelab");
        profile.id = "11111111-1111-4111-8111-111111111111".to_string();
        let saved = store.upsert(profile).unwrap();
        assert_eq!(saved.id, "11111111-1111-4111-8111-111111111111");
        assert_eq!(store.list().profiles.len(), 1);
    }

    #[test]
    fn upsert_validation_rejection_does_not_touch_disk() {
        let dir = tempdir().unwrap();
        let store = ProfileStore::load(dir.path().to_path_buf());
        let mut invalid = sample_profile("Homelab");
        invalid.name = String::new();

        let err = store.upsert(invalid).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        assert!(store.list().profiles.is_empty());
        assert!(
            !dir.path().join(PROFILES_FILE).exists(),
            "a rejected upsert must not create profiles.json"
        );
    }

    #[test]
    fn delete_removes_profile() {
        let dir = tempdir().unwrap();
        let store = ProfileStore::load(dir.path().to_path_buf());
        let saved = store.upsert(sample_profile("Homelab")).unwrap();
        store.delete(&saved.id).unwrap();
        assert!(store.list().profiles.is_empty());
    }

    #[test]
    fn delete_unknown_id_returns_not_found() {
        let dir = tempdir().unwrap();
        let store = ProfileStore::load(dir.path().to_path_buf());
        let err = store.delete("does-not-exist").unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn atomic_write_leaves_no_leftover_temp_file_and_valid_content() {
        let dir = tempdir().unwrap();
        let store = ProfileStore::load(dir.path().to_path_buf());
        store.upsert(sample_profile("Homelab")).unwrap();
        store.upsert(sample_profile("Office")).unwrap();

        let entries: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            entries,
            vec![PROFILES_FILE.to_string()],
            "only the final profiles.json should remain — no dangling .tmp- files"
        );

        let raw = fs::read_to_string(dir.path().join(PROFILES_FILE)).unwrap();
        let parsed: ProfilesFile = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed.version, 1);
        assert_eq!(parsed.profiles.len(), 2);
    }

    #[test]
    fn a_stray_leftover_temp_file_does_not_break_loading() {
        // Simulates a crash between the temp-write and the rename in a
        // previous process: a `.tmp-*` file sits next to a valid
        // profiles.json. Loading must only ever consider profiles.json.
        let dir = tempdir().unwrap();
        let store = ProfileStore::load(dir.path().to_path_buf());
        let saved = store.upsert(sample_profile("Homelab")).unwrap();
        fs::write(dir.path().join("profiles.json.tmp-leftover"), "not json").unwrap();

        let reloaded = ProfileStore::load(dir.path().to_path_buf());
        assert_eq!(reloaded.list().profiles, vec![saved]);
    }

    #[test]
    fn corrupt_file_is_backed_up_and_store_starts_empty() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(PROFILES_FILE), "{ not valid json ").unwrap();

        let store = ProfileStore::load(dir.path().to_path_buf());
        assert!(store.list().profiles.is_empty());

        // Original corrupt file is gone from its original path...
        assert!(!dir.path().join(PROFILES_FILE).exists());

        // ...and a backup with the expected naming pattern exists containing
        // the original (corrupt) content, so nothing was silently destroyed.
        let backups: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("profiles.json.corrupt-"))
            .collect();
        assert_eq!(backups.len(), 1, "expected exactly one backup file");
        let backup_content = fs::read_to_string(dir.path().join(&backups[0])).unwrap();
        assert_eq!(backup_content, "{ not valid json ");

        // The store is still usable afterward.
        store.upsert(sample_profile("Homelab")).unwrap();
        assert!(dir.path().join(PROFILES_FILE).exists());
    }

    // -- B1: persist failure must not diverge memory from disk ------------

    /// Forces the store's next `persist()` to fail (see the identical helper
    /// in `store.rs` for why a blocking file, not a permission bit, is used).
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
        let store = ProfileStore::load(store_dir);

        let err = store.upsert(sample_profile("Homelab")).unwrap_err();
        assert!(matches!(err, AppError::Io(_)));
        assert!(
            store.list().profiles.is_empty(),
            "a failed persist must not leave the upsert applied in memory"
        );
    }

    #[test]
    fn delete_leaves_memory_unchanged_when_persist_fails() {
        let root = tempdir().unwrap();
        let store_dir = root.path().join("store");
        let store = ProfileStore::load(store_dir.clone());
        let saved = store.upsert(sample_profile("Homelab")).unwrap();

        block_store_dir_with_a_file(&store_dir);

        let err = store.delete(&saved.id).unwrap_err();
        assert!(matches!(err, AppError::Io(_)));
        assert_eq!(
            store.list().profiles,
            vec![saved],
            "a failed persist must not leave the delete applied in memory"
        );
    }

    #[test]
    fn set_default_leaves_memory_unchanged_when_persist_fails() {
        let root = tempdir().unwrap();
        let store_dir = root.path().join("store");
        let store = ProfileStore::load(store_dir.clone());
        let saved = store.upsert(sample_profile("Homelab")).unwrap();

        block_store_dir_with_a_file(&store_dir);

        let err = store.set_default(Some(saved.id)).unwrap_err();
        assert!(matches!(err, AppError::Io(_)));
        assert_eq!(
            store.list().default_profile_id,
            None,
            "a failed persist must not leave the default applied in memory"
        );
    }

    #[test]
    fn clear_device_leaves_memory_unchanged_when_persist_fails() {
        let root = tempdir().unwrap();
        let store_dir = root.path().join("store");
        let store = ProfileStore::load(store_dir.clone());
        let saved = store
            .upsert(sample_profile_with_devices(
                "Homelab",
                [Some("dev-1"), None],
            ))
            .unwrap();

        block_store_dir_with_a_file(&store_dir);

        let err = store.clear_device("dev-1").unwrap_err();
        assert!(matches!(err, AppError::Io(_)));
        assert_eq!(
            store.list().profiles,
            vec![saved],
            "a failed persist must not leave the referential cleanup applied in memory"
        );
    }

    #[test]
    fn wire_format_wrapper_matches_spec_shape() {
        let dir = tempdir().unwrap();
        let store = ProfileStore::load(dir.path().to_path_buf());
        let saved = store.upsert(sample_profile("Homelab")).unwrap();
        store.set_default(Some(saved.id.clone())).unwrap();

        let raw = fs::read_to_string(dir.path().join(PROFILES_FILE)).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(value["defaultProfileId"], saved.id);
        assert!(value["profiles"].is_array());
        assert_eq!(value["profiles"][0]["id"], saved.id);
    }

    // -- defaultProfileId invariants (PLAN.md Phase 4 task 5) ---------------

    #[test]
    fn deleting_the_default_profile_clears_default_profile_id() {
        let dir = tempdir().unwrap();
        let store = ProfileStore::load(dir.path().to_path_buf());
        let saved = store.upsert(sample_profile("Homelab")).unwrap();
        store.set_default(Some(saved.id.clone())).unwrap();
        assert_eq!(store.list().default_profile_id, Some(saved.id.clone()));

        store.delete(&saved.id).unwrap();

        assert_eq!(store.list().default_profile_id, None);

        // Also true after a reload, i.e. it was actually persisted.
        let reloaded = ProfileStore::load(dir.path().to_path_buf());
        assert_eq!(reloaded.list().default_profile_id, None);
    }

    #[test]
    fn deleting_a_non_default_profile_leaves_default_unchanged() {
        let dir = tempdir().unwrap();
        let store = ProfileStore::load(dir.path().to_path_buf());
        let default = store.upsert(sample_profile("Homelab")).unwrap();
        let other = store.upsert(sample_profile("Office")).unwrap();
        store.set_default(Some(default.id.clone())).unwrap();

        store.delete(&other.id).unwrap();

        assert_eq!(store.list().default_profile_id, Some(default.id));
    }

    #[test]
    fn set_default_to_nonexistent_id_is_not_found_and_does_not_change_state() {
        let dir = tempdir().unwrap();
        let store = ProfileStore::load(dir.path().to_path_buf());
        let saved = store.upsert(sample_profile("Homelab")).unwrap();
        store.set_default(Some(saved.id.clone())).unwrap();

        let err = store
            .set_default(Some("does-not-exist".to_string()))
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));

        // The previous default must survive the rejected call.
        assert_eq!(store.list().default_profile_id, Some(saved.id));
    }

    #[test]
    fn set_default_to_none_clears_default() {
        let dir = tempdir().unwrap();
        let store = ProfileStore::load(dir.path().to_path_buf());
        let saved = store.upsert(sample_profile("Homelab")).unwrap();
        store.set_default(Some(saved.id)).unwrap();

        store.set_default(None).unwrap();

        assert_eq!(store.list().default_profile_id, None);
    }

    #[test]
    fn set_default_persists_across_reload() {
        let dir = tempdir().unwrap();
        let store = ProfileStore::load(dir.path().to_path_buf());
        let saved = store.upsert(sample_profile("Homelab")).unwrap();
        store.set_default(Some(saved.id.clone())).unwrap();

        let reloaded = ProfileStore::load(dir.path().to_path_buf());
        assert_eq!(reloaded.list().default_profile_id, Some(saved.id));
    }

    // -- device-deletion referential cleanup (PLAN.md Phase 4 task 5) -------

    #[test]
    fn clear_device_nulls_matching_panes_across_profiles() {
        let dir = tempdir().unwrap();
        let store = ProfileStore::load(dir.path().to_path_buf());
        let with_device = store
            .upsert(sample_profile_with_devices(
                "Homelab",
                [Some("dev-1"), Some("dev-2")],
            ))
            .unwrap();
        let also_with_device = store
            .upsert(sample_profile_with_devices("Office", [Some("dev-1"), None]))
            .unwrap();

        store.clear_device("dev-1").unwrap();

        let profiles = store.list().profiles;
        let updated = profiles.iter().find(|p| p.id == with_device.id).unwrap();
        assert_eq!(updated.panes[0].device_id, None, "dev-1 pane nulled");
        assert_eq!(
            updated.panes[1].device_id,
            Some("dev-2".to_string()),
            "dev-2 pane untouched"
        );
        let updated_other = profiles
            .iter()
            .find(|p| p.id == also_with_device.id)
            .unwrap();
        assert_eq!(updated_other.panes[0].device_id, None);

        // Persisted, not just in-memory.
        let reloaded = ProfileStore::load(dir.path().to_path_buf());
        let reloaded_profile = reloaded
            .list()
            .profiles
            .into_iter()
            .find(|p| p.id == with_device.id)
            .unwrap();
        assert_eq!(reloaded_profile.panes[0].device_id, None);
    }

    #[test]
    fn clear_device_leaves_unreferenced_profiles_untouched() {
        let dir = tempdir().unwrap();
        let store = ProfileStore::load(dir.path().to_path_buf());
        let unrelated = store
            .upsert(sample_profile_with_devices("Office", [Some("dev-2"), None]))
            .unwrap();

        store.clear_device("dev-1").unwrap();

        let profiles = store.list().profiles;
        let still = profiles.iter().find(|p| p.id == unrelated.id).unwrap();
        assert_eq!(still.panes[0].device_id, Some("dev-2".to_string()));
    }

    #[test]
    fn clear_device_with_no_matches_does_not_write_the_file() {
        // An empty store (never saved anything) must not have profiles.json
        // conjured into existence by an unrelated device deletion.
        let dir = tempdir().unwrap();
        let store = ProfileStore::load(dir.path().to_path_buf());

        store.clear_device("dev-1").unwrap();

        assert!(!dir.path().join(PROFILES_FILE).exists());
    }

    // -- reload: multi-instance sync ---------------------------------------

    #[test]
    fn reload_picks_up_profiles_and_default_written_by_another_instance() {
        let dir = tempdir().unwrap();
        let store = ProfileStore::load(dir.path().to_path_buf());
        store.upsert(sample_profile("Homelab")).unwrap();
        assert_eq!(store.list().profiles.len(), 1);
        assert_eq!(store.list().default_profile_id, None);

        // A second instance adds a profile and marks it default.
        let other = ProfileStore::load(dir.path().to_path_buf());
        let added = other.upsert(sample_profile("Office")).unwrap();
        other.set_default(Some(added.id.clone())).unwrap();

        assert_eq!(store.list().profiles.len(), 1, "stale until reloaded");

        store.reload();

        let list = store.list();
        assert_eq!(list.profiles.len(), 2);
        assert_eq!(list.default_profile_id, Some(added.id));
    }

    #[test]
    fn reload_recovers_to_empty_when_the_file_disappears() {
        let dir = tempdir().unwrap();
        let store = ProfileStore::load(dir.path().to_path_buf());
        store.upsert(sample_profile("Homelab")).unwrap();
        store
            .set_default(Some(store.list().profiles[0].id.clone()))
            .unwrap();

        fs::remove_file(dir.path().join(PROFILES_FILE)).unwrap();
        store.reload();

        let list = store.list();
        assert!(list.profiles.is_empty());
        assert_eq!(list.default_profile_id, None);
    }
}
