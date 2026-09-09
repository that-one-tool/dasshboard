//! `KnownHostsStore` (SPEC.md §4/§6): a trust-on-first-use (TOFU) record of
//! server host keys, persisted to `known_hosts.json`.
//!
//! On-disk shape (SPEC.md §4):
//! ```jsonc
//! { "version": 1, "hosts": { "192.168.1.10:22": { "keyType": "ssh-ed25519", "fingerprint": "SHA256:..." } } }
//! ```
//!
//! The matching decision (`Verdict`) is a pure function of the stored record
//! and the presented fingerprint, so it is unit-tested without any filesystem
//! or network. Persistence uses the same atomic write-then-rename strategy as
//! `DeviceStore`.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppError;

const KNOWN_HOSTS_FILE: &str = "known_hosts.json";
const CURRENT_VERSION: u32 = 1;

/// A single stored host key record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    pub key_type: String,
    pub fingerprint: String,
}

/// One trusted-host row surfaced to the management UI (`list_known_hosts`).
/// Carries the composite `host:port` map key verbatim as `id` (which is also
/// its display label and the handle `forget_host` takes back), so the frontend
/// never has to re-parse or re-join host/port — and IPv6 hosts, which contain
/// colons, stay unambiguous. Serialize-only: it is never read back from disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostEntry {
    pub id: String,
    pub key_type: String,
    pub fingerprint: String,
}

/// On-disk shape of `known_hosts.json`.
#[derive(Debug, Serialize, Deserialize)]
struct KnownHostsFile {
    version: u32,
    hosts: HashMap<String, KnownHost>,
}

/// The outcome of comparing a presented host key against the store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// No record exists for this host:port — first contact (TOFU prompt,
    /// `changed: false`).
    Unknown,
    /// A record exists and the fingerprint matches — proceed silently.
    Known,
    /// A record exists but the fingerprint differs — possible MITM
    /// (`changed: true`, loud warning).
    Changed,
}

/// Builds the `host:port` map key used both in memory and on disk.
pub fn host_key(host: &str, port: u16) -> String {
    format!("{host}:{port}")
}

/// Pure matching logic (unit-tested): decide the [`Verdict`] for a presented
/// fingerprint given the optionally-stored record.
pub fn verdict_for(stored: Option<&KnownHost>, presented_fingerprint: &str) -> Verdict {
    match stored {
        None => Verdict::Unknown,
        Some(known) if known.fingerprint == presented_fingerprint => Verdict::Known,
        Some(_) => Verdict::Changed,
    }
}

pub struct KnownHostsStore {
    dir: PathBuf,
    hosts: Mutex<HashMap<String, KnownHost>>,
}

impl KnownHostsStore {
    /// Loads `dir/known_hosts.json`. Never panics and never returns an error:
    /// a missing file yields an empty store, and a corrupt file is backed up
    /// to `known_hosts.json.corrupt-<unix-seconds>` and treated as empty (a
    /// corrupt trust store must not brick connecting — the user is simply
    /// re-prompted via TOFU). Neither the file nor these log lines ever
    /// contain secret material.
    pub fn load(dir: PathBuf) -> Self {
        let path = dir.join(KNOWN_HOSTS_FILE);
        let hosts = match fs::read_to_string(&path) {
            Ok(contents) => match serde_json::from_str::<KnownHostsFile>(&contents) {
                Ok(parsed) => parsed.hosts,
                Err(err) => {
                    eprintln!(
                        "[DaSSHboard] known_hosts.json is corrupt ({err}); backing it up and starting empty"
                    );
                    Self::backup_corrupt(&path);
                    HashMap::new()
                }
            },
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(err) => {
                eprintln!(
                    "[DaSSHboard] could not read known_hosts.json ({err}); backing it up and starting empty"
                );
                Self::backup_corrupt(&path);
                HashMap::new()
            }
        };
        KnownHostsStore {
            dir,
            hosts: Mutex::new(hosts),
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
        let backup_path = path.with_file_name(format!("known_hosts.json.corrupt-{timestamp}"));
        if let Err(err) = fs::rename(path, &backup_path) {
            eprintln!("[DaSSHboard] failed to back up corrupt known_hosts.json: {err}");
        }
    }

    /// Returns the [`Verdict`] for a presented host key without mutating the
    /// store. Locks only briefly and never across an `.await`.
    pub fn verdict(&self, host: &str, port: u16, presented_fingerprint: &str) -> Verdict {
        let key = host_key(host, port);
        let hosts = self.lock_hosts();
        verdict_for(hosts.get(&key), presented_fingerprint)
    }

    /// Records (TOFU) or overwrites (accepted key change) the host key for
    /// `host:port`, persisting the whole store atomically.
    pub fn trust(&self, host: &str, port: u16, entry: KnownHost) -> Result<(), AppError> {
        let key = host_key(host, port);
        let snapshot = {
            let mut hosts = self.lock_hosts();
            hosts.insert(key, entry);
            hosts.clone()
        };
        self.persist(&snapshot)
    }

    /// Test/introspection helper: the stored record for a host, if any.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn get(&self, host: &str, port: u16) -> Option<KnownHost> {
        self.lock_hosts().get(&host_key(host, port)).cloned()
    }

    /// Snapshot of every trusted host for the management UI, sorted by `id`
    /// (`host:port`) so the list has a stable order across calls. Locks only
    /// to clone the map out; never across I/O.
    pub fn list(&self) -> Vec<KnownHostEntry> {
        let mut entries: Vec<KnownHostEntry> = self
            .lock_hosts()
            .iter()
            .map(|(id, host)| KnownHostEntry {
                id: id.clone(),
                key_type: host.key_type.clone(),
                fingerprint: host.fingerprint.clone(),
            })
            .collect();
        entries.sort_by(|a, b| a.id.cmp(&b.id));
        entries
    }

    /// Forget a trusted host by its composite `id` (`host:port`), persisting
    /// the store afterwards. Returns whether an entry was actually removed, so
    /// forgetting an id that is already gone is a harmless `Ok(false)` (the row
    /// the user clicked simply no longer exists) rather than an error. The
    /// store is only rewritten when something changed.
    pub fn forget(&self, id: &str) -> Result<bool, AppError> {
        let snapshot = {
            let mut hosts = self.lock_hosts();
            if hosts.remove(id).is_none() {
                return Ok(false);
            }
            hosts.clone()
        };
        self.persist(&snapshot)?;
        Ok(true)
    }

    fn lock_hosts(&self) -> std::sync::MutexGuard<'_, HashMap<String, KnownHost>> {
        self.hosts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Atomic write: serialize to a temp file in the same directory, then
    /// `rename` over the real file (atomic within one directory on both
    /// Windows and POSIX). Takes a snapshot so no lock is held during I/O.
    fn persist(&self, hosts: &HashMap<String, KnownHost>) -> Result<(), AppError> {
        fs::create_dir_all(&self.dir)?;
        let file = KnownHostsFile {
            version: CURRENT_VERSION,
            hosts: hosts.clone(),
        };
        let json = serde_json::to_string_pretty(&file)?;
        let tmp_path = self
            .dir
            .join(format!("{KNOWN_HOSTS_FILE}.tmp-{}", Uuid::new_v4()));
        fs::write(&tmp_path, json)?;
        fs::rename(&tmp_path, self.dir.join(KNOWN_HOSTS_FILE))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn ed25519(fp: &str) -> KnownHost {
        KnownHost {
            key_type: "ssh-ed25519".to_string(),
            fingerprint: fp.to_string(),
        }
    }

    #[test]
    fn verdict_unknown_when_absent() {
        assert_eq!(verdict_for(None, "SHA256:aaa"), Verdict::Unknown);
    }

    #[test]
    fn verdict_known_when_fingerprint_matches() {
        let stored = ed25519("SHA256:aaa");
        assert_eq!(verdict_for(Some(&stored), "SHA256:aaa"), Verdict::Known);
    }

    #[test]
    fn verdict_changed_when_fingerprint_differs() {
        let stored = ed25519("SHA256:aaa");
        assert_eq!(verdict_for(Some(&stored), "SHA256:bbb"), Verdict::Changed);
    }

    #[test]
    fn host_key_formats_host_and_port() {
        assert_eq!(host_key("192.168.1.10", 22), "192.168.1.10:22");
        assert_eq!(host_key("example.com", 2222), "example.com:2222");
    }

    #[test]
    fn missing_file_is_empty_and_not_created_by_loading() {
        let dir = tempdir().unwrap();
        let store = KnownHostsStore::load(dir.path().to_path_buf());
        assert_eq!(store.verdict("h", 22, "SHA256:x"), Verdict::Unknown);
        assert!(!dir.path().join(KNOWN_HOSTS_FILE).exists());
    }

    #[test]
    fn trust_then_verdict_is_known_and_persists() {
        let dir = tempdir().unwrap();
        let store = KnownHostsStore::load(dir.path().to_path_buf());
        store.trust("h", 22, ed25519("SHA256:abc")).unwrap();
        assert_eq!(store.verdict("h", 22, "SHA256:abc"), Verdict::Known);

        // A different port is a different identity.
        assert_eq!(store.verdict("h", 23, "SHA256:abc"), Verdict::Unknown);

        // Reload from disk into a fresh store proves persistence.
        let reloaded = KnownHostsStore::load(dir.path().to_path_buf());
        assert_eq!(reloaded.verdict("h", 22, "SHA256:abc"), Verdict::Known);
    }

    #[test]
    fn trust_overwrites_on_accepted_change() {
        let dir = tempdir().unwrap();
        let store = KnownHostsStore::load(dir.path().to_path_buf());
        store.trust("h", 22, ed25519("SHA256:old")).unwrap();
        assert_eq!(store.verdict("h", 22, "SHA256:new"), Verdict::Changed);

        store.trust("h", 22, ed25519("SHA256:new")).unwrap();
        assert_eq!(store.verdict("h", 22, "SHA256:new"), Verdict::Known);

        let reloaded = KnownHostsStore::load(dir.path().to_path_buf());
        assert_eq!(reloaded.get("h", 22), Some(ed25519("SHA256:new")));
    }

    #[test]
    fn list_returns_all_hosts_sorted_by_id() {
        let dir = tempdir().unwrap();
        let store = KnownHostsStore::load(dir.path().to_path_buf());
        store
            .trust("zeta.example", 22, ed25519("SHA256:z"))
            .unwrap();
        store
            .trust("alpha.example", 22, ed25519("SHA256:a"))
            .unwrap();
        store
            .trust("alpha.example", 2222, ed25519("SHA256:b"))
            .unwrap();

        let ids: Vec<String> = store.list().into_iter().map(|e| e.id).collect();
        assert_eq!(
            ids,
            vec![
                "alpha.example:22".to_string(),
                "alpha.example:2222".to_string(),
                "zeta.example:22".to_string(),
            ]
        );
    }

    #[test]
    fn list_is_empty_for_a_fresh_store() {
        let dir = tempdir().unwrap();
        let store = KnownHostsStore::load(dir.path().to_path_buf());
        assert!(store.list().is_empty());
    }

    #[test]
    fn forget_removes_entry_and_persists() {
        let dir = tempdir().unwrap();
        let store = KnownHostsStore::load(dir.path().to_path_buf());
        store.trust("h", 22, ed25519("SHA256:abc")).unwrap();

        assert!(store.forget("h:22").unwrap(), "an existing host is removed");
        assert_eq!(store.verdict("h", 22, "SHA256:abc"), Verdict::Unknown);

        // The removal is durable: a fresh store no longer knows the host.
        let reloaded = KnownHostsStore::load(dir.path().to_path_buf());
        assert!(reloaded.get("h", 22).is_none());
    }

    #[test]
    fn forget_unknown_id_is_ok_false_and_leaves_others() {
        let dir = tempdir().unwrap();
        let store = KnownHostsStore::load(dir.path().to_path_buf());
        store.trust("h", 22, ed25519("SHA256:abc")).unwrap();

        assert!(
            !store.forget("nope:22").unwrap(),
            "a missing id removes nothing"
        );
        assert_eq!(store.verdict("h", 22, "SHA256:abc"), Verdict::Known);
    }

    #[test]
    fn atomic_write_leaves_no_temp_files() {
        let dir = tempdir().unwrap();
        let store = KnownHostsStore::load(dir.path().to_path_buf());
        store.trust("h", 22, ed25519("SHA256:abc")).unwrap();

        let entries: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec![KNOWN_HOSTS_FILE.to_string()]);
    }

    #[test]
    fn corrupt_file_is_backed_up_and_store_starts_empty() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(KNOWN_HOSTS_FILE), "{ not json ").unwrap();

        let store = KnownHostsStore::load(dir.path().to_path_buf());
        assert_eq!(store.verdict("h", 22, "SHA256:x"), Verdict::Unknown);
        assert!(!dir.path().join(KNOWN_HOSTS_FILE).exists());

        let backups: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("known_hosts.json.corrupt-"))
            .collect();
        assert_eq!(backups.len(), 1);

        // Still usable afterwards.
        store.trust("h", 22, ed25519("SHA256:abc")).unwrap();
        assert!(dir.path().join(KNOWN_HOSTS_FILE).exists());
    }
}
