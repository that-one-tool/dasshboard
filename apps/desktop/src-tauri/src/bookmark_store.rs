//! Per-device SFTP bookmarks (#5): saved remote directory paths the user can
//! jump back to from the Files panel. A tiny store keyed by device id → an
//! ordered list of remote paths, persisted to `sftp_bookmarks.json` with the
//! same atomic-write + corrupt-recovery pattern as the other stores.
//!
//! Add/remove are idempotent: a path is never stored twice for a device, and
//! removing an absent path (or a device with none) is a no-op. Like the other
//! stores, the in-memory map is only swapped once the disk write succeeds, so a
//! failed write never diverges memory from disk. Takes a directory path injected
//! by the caller (production: the app-config dir; tests: a temp dir).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::atomic_file;
use crate::error::AppError;

const BOOKMARKS_FILE: &str = "sftp_bookmarks.json";
const CURRENT_VERSION: u32 = 1;

/// device id → its bookmarked remote paths, in saved order. A `BTreeMap` keeps
/// the serialized file deterministic (stable key order across saves).
type Bookmarks = BTreeMap<String, Vec<String>>;

/// On-disk shape of `sftp_bookmarks.json`.
#[derive(Debug, Serialize, Deserialize)]
struct BookmarksFile {
    version: u32,
    #[serde(default)]
    bookmarks: Bookmarks,
}

pub struct BookmarkStore {
    dir: PathBuf,
    state: Mutex<Bookmarks>,
}

impl BookmarkStore {
    /// Load `dir/sftp_bookmarks.json`. Never panics/errors to the caller: a
    /// missing file yields an empty map, a corrupt one is backed up first.
    pub fn load(dir: PathBuf) -> Self {
        let state = atomic_file::read_recovering::<BookmarksFile, _>(
            &dir,
            BOOKMARKS_FILE,
            |file| file.bookmarks,
            Bookmarks::new,
        );
        Self {
            dir,
            state: Mutex::new(state),
        }
    }

    /// The bookmarked paths for a device, in saved order (empty if none).
    pub fn list(&self, device_id: &str) -> Vec<String> {
        atomic_file::lock(&self.state)
            .get(device_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Add `path` for `device_id` (a duplicate is ignored) and persist. Returns
    /// the device's updated list.
    pub fn add(&self, device_id: &str, path: &str) -> Result<Vec<String>, AppError> {
        self.mutate(device_id, |paths| {
            if !paths.iter().any(|p| p == path) {
                paths.push(path.to_string());
            }
        })
    }

    /// Remove `path` for `device_id` (absent ⇒ no-op) and persist. Returns the
    /// device's updated list.
    pub fn remove(&self, device_id: &str, path: &str) -> Result<Vec<String>, AppError> {
        self.mutate(device_id, |paths| paths.retain(|p| p != path))
    }

    /// Apply `edit` to a device's list on a fresh copy, persist, then commit —
    /// so a failed write leaves memory (and disk) unchanged. Drops a device key
    /// that ends up empty. Returns the device's resulting list.
    fn mutate(
        &self,
        device_id: &str,
        edit: impl FnOnce(&mut Vec<String>),
    ) -> Result<Vec<String>, AppError> {
        let mut guard = atomic_file::lock(&self.state);
        let mut next = guard.clone();
        {
            let paths = next.entry(device_id.to_string()).or_default();
            edit(paths);
            if paths.is_empty() {
                next.remove(device_id);
            }
        }
        self.persist(&next)?;
        let result = next.get(device_id).cloned().unwrap_or_default();
        *guard = next;
        Ok(result)
    }

    fn persist(&self, bookmarks: &Bookmarks) -> Result<(), AppError> {
        let file = BookmarksFile {
            version: CURRENT_VERSION,
            bookmarks: bookmarks.clone(),
        };
        atomic_file::write_json(&self.dir, BOOKMARKS_FILE, &file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn missing_file_yields_no_bookmarks_and_creates_nothing() {
        let dir = tempdir().unwrap();
        let store = BookmarkStore::load(dir.path().to_path_buf());
        assert!(store.list("dev-1").is_empty());
        assert!(!dir.path().join(BOOKMARKS_FILE).exists());
    }

    #[test]
    fn add_is_idempotent_and_ordered_per_device() {
        let dir = tempdir().unwrap();
        let store = BookmarkStore::load(dir.path().to_path_buf());
        store.add("dev-1", "/etc").unwrap();
        store.add("dev-1", "/var/log").unwrap();
        store.add("dev-1", "/etc").unwrap(); // duplicate ignored
        store.add("dev-2", "/home").unwrap();

        assert_eq!(store.list("dev-1"), vec!["/etc", "/var/log"]);
        assert_eq!(store.list("dev-2"), vec!["/home"]);
    }

    #[test]
    fn remove_drops_the_path_and_an_emptied_device() {
        let dir = tempdir().unwrap();
        let store = BookmarkStore::load(dir.path().to_path_buf());
        store.add("dev-1", "/etc").unwrap();
        store.add("dev-1", "/var").unwrap();

        assert_eq!(store.remove("dev-1", "/etc").unwrap(), vec!["/var"]);
        assert!(store.remove("dev-1", "/nope").unwrap() == vec!["/var"]); // absent no-op
        assert!(store.remove("dev-1", "/var").unwrap().is_empty());

        // The now-empty device key is gone from the file.
        let raw = fs::read_to_string(dir.path().join(BOOKMARKS_FILE)).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(value["bookmarks"].get("dev-1").is_none());
    }

    #[test]
    fn bookmarks_round_trip_across_loads() {
        let dir = tempdir().unwrap();
        {
            let store = BookmarkStore::load(dir.path().to_path_buf());
            store.add("dev-1", "/etc").unwrap();
            store.add("dev-1", "/srv").unwrap();
        }
        let reloaded = BookmarkStore::load(dir.path().to_path_buf());
        assert_eq!(reloaded.list("dev-1"), vec!["/etc", "/srv"]);
    }

    #[test]
    fn wire_format_carries_version() {
        let dir = tempdir().unwrap();
        let store = BookmarkStore::load(dir.path().to_path_buf());
        store.add("dev-1", "/etc").unwrap();

        let raw = fs::read_to_string(dir.path().join(BOOKMARKS_FILE)).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(value["bookmarks"]["dev-1"][0], "/etc");
    }

    #[test]
    fn corrupt_file_is_backed_up_and_starts_empty() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(BOOKMARKS_FILE), "{ not json ").unwrap();
        let store = BookmarkStore::load(dir.path().to_path_buf());
        assert!(store.list("dev-1").is_empty());
        let backups = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("sftp_bookmarks.json.corrupt-")
            })
            .count();
        assert_eq!(backups, 1);
    }
}
