//! Shared JSON-file persistence mechanics used by every config store
//! (`DeviceStore`, `ProfileStore`, `SettingsStore`, `KnownHostsStore`).
//!
//! Each store keeps its own on-disk wrapper type, in-memory state, and domain
//! logic (upsert/delete/…); this module owns only the plumbing they all
//! repeated verbatim:
//!
//! - [`write_json`] — atomic write-then-rename;
//! - [`backup_corrupt`] — move an unreadable/unparseable file out of the way;
//! - [`read_recovering`] — the missing-file/corrupt-file read-recovery flow;
//! - [`lock`] — a poison-recovering mutex lock.
//!
//! None of these ever touch secret material — secrets live in the OS keyring
//! (`crate::secret`), never in these JSON files.

use std::fs;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use uuid::Uuid;

use crate::error::AppError;

/// Locks a store's state mutex, recovering the inner value if a previous holder
/// panicked. A poisoned lock must never take a store down: the data behind it
/// is still structurally valid, so we step over the poison rather than
/// propagating a panic to every later caller.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Atomically writes `value` as pretty JSON to `dir/file_name`: serialize to a
/// uniquely-named temp file in the same directory, then `rename` it over the
/// real file. A `rename` within one directory is atomic on both Windows and
/// POSIX filesystems, so a concurrent reader only ever sees the fully-old or
/// fully-new content, never a partial write. Creates `dir` if it doesn't exist.
pub fn write_json<T: Serialize>(dir: &Path, file_name: &str, value: &T) -> Result<(), AppError> {
    fs::create_dir_all(dir)?;
    let json = serde_json::to_string_pretty(value)?;
    let tmp_path = dir.join(format!("{file_name}.tmp-{}", Uuid::new_v4()));
    fs::write(&tmp_path, json)?;
    fs::rename(&tmp_path, dir.join(file_name))?;
    Ok(())
}

/// Renames an unreadable/corrupt file to `<name>.corrupt-<unix-seconds>` so a
/// store can start fresh without silently destroying the original. Best effort:
/// a failure to back it up is logged, not fatal. A no-op if the file is already
/// gone (e.g. it was never created).
pub fn backup_corrupt(path: &Path) {
    if !path.exists() {
        return;
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("config");
    let backup_path = path.with_file_name(format!("{name}.corrupt-{timestamp}"));
    if let Err(err) = fs::rename(path, &backup_path) {
        eprintln!("[DaSSHboard] failed to back up corrupt {name}: {err}");
    }
}

/// Reads and parses `dir/file_name` into a store's in-memory state, recovering
/// rather than failing on a missing or corrupt file:
///
/// - missing file → `default()` (the file is created on the first save);
/// - unreadable or unparseable file → the bad file is backed up (see
///   [`backup_corrupt`]) and `default()` is used.
///
/// `map` converts the parsed on-disk shape `D` into the in-memory state `T`
/// (e.g. unwrapping a `{ version, devices }` envelope to its `devices`, or
/// sanitizing loaded settings). Recovery logs one line to stderr, never
/// containing file contents beyond the serde error's own position info.
pub fn read_recovering<D, T>(
    dir: &Path,
    file_name: &str,
    map: impl FnOnce(D) -> T,
    default: impl FnOnce() -> T,
) -> T
where
    D: serde::de::DeserializeOwned,
{
    let path = dir.join(file_name);
    match fs::read_to_string(&path) {
        Ok(contents) => match serde_json::from_str::<D>(&contents) {
            Ok(parsed) => map(parsed),
            Err(err) => {
                eprintln!(
                    "[DaSSHboard] {file_name} is corrupt ({err}); backing it up and starting fresh"
                );
                backup_corrupt(&path);
                default()
            }
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => default(),
        Err(err) => {
            eprintln!(
                "[DaSSHboard] could not read {file_name} ({err}); backing it up and starting fresh"
            );
            backup_corrupt(&path);
            default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::sync::Arc;
    use tempfile::tempdir;

    const FILE: &str = "sample.json";

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    struct Sample {
        version: u32,
        items: Vec<String>,
    }

    fn sample() -> Sample {
        Sample {
            version: 1,
            items: vec!["a".to_string(), "b".to_string()],
        }
    }

    #[test]
    fn write_json_round_trips_and_leaves_no_temp_file() {
        let dir = tempdir().unwrap();
        write_json(dir.path(), FILE, &sample()).unwrap();

        // Only the final file remains — no dangling `.tmp-*`.
        let entries: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec![FILE.to_string()]);

        let raw = fs::read_to_string(dir.path().join(FILE)).unwrap();
        let parsed: Sample = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed, sample());
    }

    #[test]
    fn write_json_creates_the_directory_if_missing() {
        let root = tempdir().unwrap();
        let dir = root.path().join("nested/config");
        write_json(&dir, FILE, &sample()).unwrap();
        assert!(dir.join(FILE).exists());
    }

    #[test]
    fn write_json_errors_when_the_dir_path_is_a_file() {
        // `create_dir_all` fails when a plain file sits where the dir should be,
        // surfacing as an `AppError::Io` rather than a panic.
        let root = tempdir().unwrap();
        let blocker = root.path().join("blocker");
        fs::write(&blocker, "not a dir").unwrap();
        let err = write_json(&blocker, FILE, &sample()).unwrap_err();
        assert!(matches!(err, AppError::Io(_)));
    }

    #[test]
    fn backup_corrupt_renames_the_file_out_of_the_way() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(FILE);
        fs::write(&path, "{ not json ").unwrap();

        backup_corrupt(&path);

        assert!(!path.exists(), "the original must be moved aside");
        let backups: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("sample.json.corrupt-"))
            .collect();
        assert_eq!(backups.len(), 1);
        let content = fs::read_to_string(dir.path().join(&backups[0])).unwrap();
        assert_eq!(content, "{ not json ", "content must be preserved");
    }

    #[test]
    fn backup_corrupt_is_a_noop_when_the_file_is_absent() {
        let dir = tempdir().unwrap();
        backup_corrupt(&dir.path().join(FILE)); // must not panic
        let count = fs::read_dir(dir.path()).unwrap().count();
        assert_eq!(count, 0, "no backup file should be created for nothing");
    }

    #[test]
    fn read_recovering_missing_file_uses_default() {
        let dir = tempdir().unwrap();
        let out: Vec<String> =
            read_recovering::<Sample, _>(dir.path(), FILE, |s| s.items, Vec::new);
        assert!(out.is_empty());
        assert!(
            !dir.path().join(FILE).exists(),
            "reading must not create it"
        );
    }

    #[test]
    fn read_recovering_valid_file_is_mapped() {
        let dir = tempdir().unwrap();
        write_json(dir.path(), FILE, &sample()).unwrap();
        let out: Vec<String> =
            read_recovering::<Sample, _>(dir.path(), FILE, |s| s.items, Vec::new);
        assert_eq!(out, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn read_recovering_corrupt_file_is_backed_up_and_defaults() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(FILE), "{ not valid json ").unwrap();

        let out: Vec<String> =
            read_recovering::<Sample, _>(dir.path(), FILE, |s| s.items, Vec::new);

        assert!(out.is_empty());
        assert!(!dir.path().join(FILE).exists());
        let backups = fs::read_dir(dir.path())
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("sample.json.corrupt-")
            })
            .count();
        assert_eq!(backups, 1);
    }

    #[test]
    fn lock_recovers_from_a_poisoned_mutex() {
        let mutex = Arc::new(Mutex::new(vec![1, 2, 3]));
        let clone = Arc::clone(&mutex);
        // Poison the mutex by panicking while holding the guard.
        let _ = std::thread::spawn(move || {
            let _guard = clone.lock().unwrap();
            panic!("poison it");
        })
        .join();

        // A plain `.lock().unwrap()` would now panic; `lock` steps over it.
        let guard = lock(&mutex);
        assert_eq!(*guard, vec![1, 2, 3]);
    }
}
