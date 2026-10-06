//! `KnownHostsStore` (SPEC.md §4/§6): a trust-on-first-use (TOFU) record of
//! server host keys, persisted to `known_hosts.json`.
//!
//! On-disk shape (SPEC.md §4):
//! ```jsonc
//! { "version": 1, "hosts": { "192.168.1.10:22": { "keyType": "ssh-ed25519", "fingerprint": "SHA256:..." } } }
//! ```
//!
//! A damaged file is backed up and replaced by an empty one marked
//! `"resetAt": <unix-seconds>`: until the user dismisses that, a host with no
//! record may be one the lost file trusted, so it is [`Verdict::Unverifiable`]
//! rather than a plain first contact. (A 1.33 instance reads the file but
//! drops the mark when it writes.)
//!
//! A file that can't be read at launch (e.g. locked by an antivirus) is never
//! overwritten: the store retries it before each write and refuses the write
//! while it stays unreadable, and unknown hosts are `Unverifiable` meanwhile.
//!
//! The matching decision (`Verdict`) is a pure function of the stored record
//! and the presented fingerprint, so it is unit-tested without any filesystem
//! or network. Persistence uses the same atomic write-then-rename strategy as
//! `DeviceStore`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::atomic_file::{self, ReadOutcome};
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
#[serde(rename_all = "camelCase")]
struct KnownHostsFile {
    version: u32,
    hosts: HashMap<String, KnownHost>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reset_at: Option<u64>,
}

/// The trust map, plus when a damaged file was replaced (unix seconds) if the
/// user hasn't dismissed that yet. The map started empty then, so every host
/// in it was trusted since.
#[derive(Default)]
struct TrustState {
    hosts: HashMap<String, KnownHost>,
    reset_at: Option<u64>,
    /// The file couldn't be read: the map is empty, not the file.
    unreadable: bool,
}

impl TrustState {
    fn unreadable() -> Self {
        TrustState {
            unreadable: true,
            ..TrustState::default()
        }
    }

    /// Whether a host with no record may still be one trusted before.
    fn may_miss_hosts(&self) -> bool {
        self.reset_at.is_some() || self.unreadable
    }
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
    /// No record, but the store was reset after a damaged file, so this may
    /// be a host trusted before with a key that has since changed
    /// (`trustReset: true`, loud warning).
    Unverifiable,
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
    state: Mutex<TrustState>,
}

impl KnownHostsStore {
    /// Loads `dir/known_hosts.json`. Never panics and never returns an error:
    /// a missing file yields an empty store, and a corrupt file is backed up
    /// to `known_hosts.json.corrupt-<unix-seconds>` and replaced by an empty,
    /// reset one (a corrupt trust store must not brick connecting — the user
    /// is re-prompted, with a warning). Neither the file nor these log lines
    /// ever contain secret material.
    pub fn load(dir: PathBuf) -> Self {
        let state = Self::read_from_disk(&dir).unwrap_or_else(TrustState::unreadable);
        KnownHostsStore {
            dir,
            state: Mutex::new(state),
        }
    }

    /// Re-reads `known_hosts.json` from disk, replacing the in-memory trust
    /// map. Lets a second running app instance pick up host keys another
    /// instance trusted or forgot, so its next connection's TOFU check consults
    /// fresh data (see `reload_config`). Same recovery semantics as
    /// [`load`](Self::load): a corrupt file is backed up and replaced by a
    /// reset one; an unreadable one keeps the current state.
    pub fn reload(&self) {
        if let Some(state) = Self::read_from_disk(&self.dir) {
            *self.lock_state() = state;
        }
    }

    /// Reads and parses `dir/known_hosts.json`, applying the missing-file and
    /// corrupt-file recovery shared by `load` and `reload` (see
    /// [`atomic_file::read_or_backup`]); `None` when unreadable.
    fn read_from_disk(dir: &Path) -> Option<TrustState> {
        let outcome = atomic_file::read_or_backup::<KnownHostsFile>(dir, KNOWN_HOSTS_FILE)?;
        Some(match outcome {
            ReadOutcome::Parsed(file) => TrustState {
                hosts: file.hosts,
                reset_at: file.reset_at,
                ..TrustState::default()
            },
            ReadOutcome::Missing => TrustState::default(),
            ReadOutcome::Corrupt => Self::start_after_reset(dir),
        })
    }

    /// The damaged file was moved aside: start empty, and write the reset
    /// mark right away so it outlives this run even if nothing gets trusted.
    fn start_after_reset(dir: &Path) -> TrustState {
        let state = TrustState {
            reset_at: Some(unix_now()),
            ..TrustState::default()
        };
        if let Err(err) = write_state(dir, &state) {
            eprintln!("[DaSSHboard] could not record the trusted hosts reset: {err}");
        }
        state
    }

    /// Returns the [`Verdict`] for a presented host key without mutating the
    /// store. Locks only briefly and never across an `.await`.
    pub fn verdict(&self, host: &str, port: u16, presented_fingerprint: &str) -> Verdict {
        let key = host_key(host, port);
        let state = self.lock_state();
        match verdict_for(state.hosts.get(&key), presented_fingerprint) {
            Verdict::Unknown if state.may_miss_hosts() => Verdict::Unverifiable,
            verdict => verdict,
        }
    }

    /// When the trusted hosts were reset after a damaged file (unix seconds),
    /// unless the user dismissed it.
    pub fn reset_at(&self) -> Option<u64> {
        self.lock_state().reset_at
    }

    /// The user acknowledged the reset: hosts without a record are plain
    /// first contacts again.
    pub fn dismiss_reset(&self) -> Result<(), AppError> {
        let mut state = self.lock_state();
        let Some(reset_at) = state.reset_at.take() else {
            return Ok(());
        };
        self.persist(&state)
            .inspect_err(|_| state.reset_at = Some(reset_at))
    }

    /// Records (TOFU) or overwrites (accepted key change) the host key for
    /// `host:port`, persisting the whole store atomically.
    pub fn trust(&self, host: &str, port: u16, entry: KnownHost) -> Result<(), AppError> {
        let mut state = self.lock_state();
        self.ensure_loaded(&mut state)?;
        state.hosts.insert(host_key(host, port), entry);
        self.persist(&state)
    }

    /// Test/introspection helper: the stored record for a host, if any.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn get(&self, host: &str, port: u16) -> Option<KnownHost> {
        self.lock_state().hosts.get(&host_key(host, port)).cloned()
    }

    /// Snapshot of every trusted host for the management UI, sorted by `id`
    /// (`host:port`) so the list has a stable order across calls. Locks only
    /// to clone the map out; never across I/O.
    pub fn list(&self) -> Vec<KnownHostEntry> {
        let mut entries: Vec<KnownHostEntry> = self
            .lock_state()
            .hosts
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
        let mut state = self.lock_state();
        self.ensure_loaded(&mut state)?;
        if state.hosts.remove(id).is_none() {
            return Ok(false);
        }
        self.persist(&state)?;
        Ok(true)
    }

    /// Read a file that was unreadable at launch before changing it, so a
    /// write never replaces what it holds.
    fn ensure_loaded(&self, state: &mut TrustState) -> Result<(), AppError> {
        if !state.unreadable {
            return Ok(());
        }
        *state = Self::read_from_disk(&self.dir).ok_or_else(|| {
            AppError::Io("the trusted hosts file can't be read; it was left untouched".to_string())
        })?;
        Ok(())
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, TrustState> {
        atomic_file::lock(&self.state)
    }

    /// Atomically persists the trust state (see [`atomic_file::write_json`]).
    /// Callers hold the lock while writing, so two writes can't land out of
    /// order and drop the newer one from disk.
    fn persist(&self, state: &TrustState) -> Result<(), AppError> {
        write_state(&self.dir, state)
    }
}

fn write_state(dir: &Path, state: &TrustState) -> Result<(), AppError> {
    let file = KnownHostsFile {
        version: CURRENT_VERSION,
        hosts: state.hosts.clone(),
        reset_at: state.reset_at,
    };
    atomic_file::write_json(dir, KNOWN_HOSTS_FILE, &file)
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
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

    /// Concurrent trusts (several panes meeting new hosts at once) used to
    /// write their snapshots after releasing the lock, so an older one could
    /// land last and drop a newer trust from disk.
    #[test]
    fn concurrent_trusts_all_reach_disk() {
        let dir = tempdir().unwrap();
        let store = std::sync::Arc::new(KnownHostsStore::load(dir.path().to_path_buf()));
        let threads: Vec<_> = (0..8)
            .map(|t| {
                let store = std::sync::Arc::clone(&store);
                std::thread::spawn(move || {
                    for i in 0..20 {
                        store
                            .trust(&format!("h{t}-{i}"), 22, ed25519("SHA256:x"))
                            .unwrap();
                    }
                })
            })
            .collect();
        threads.into_iter().for_each(|t| t.join().unwrap());

        let reloaded = KnownHostsStore::load(dir.path().to_path_buf());
        assert_eq!(reloaded.list().len(), 8 * 20);
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
        assert!(store.list().is_empty());

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

    // -- reset after a damaged file ---------------------------------------

    fn load_reset_store(dir: &Path) -> KnownHostsStore {
        fs::write(dir.join(KNOWN_HOSTS_FILE), "{ not json ").unwrap();
        KnownHostsStore::load(dir.to_path_buf())
    }

    /// A host the damaged file may have held can't be told apart from a new
    /// one, so it is not a plain first contact; the mark survives a restart.
    #[test]
    fn a_damaged_file_leaves_unknown_hosts_unverifiable_across_restarts() {
        let dir = tempdir().unwrap();
        let store = load_reset_store(dir.path());

        assert!(store.reset_at().is_some());
        assert_eq!(store.verdict("h", 22, "SHA256:x"), Verdict::Unverifiable);
        let restarted = KnownHostsStore::load(dir.path().to_path_buf());
        assert_eq!(restarted.reset_at(), store.reset_at());
        assert_eq!(
            restarted.verdict("h", 22, "SHA256:x"),
            Verdict::Unverifiable
        );
    }

    #[test]
    fn a_host_trusted_after_the_reset_is_checked_as_usual() {
        let dir = tempdir().unwrap();
        let store = load_reset_store(dir.path());
        store.trust("h", 22, ed25519("SHA256:abc")).unwrap();

        assert_eq!(store.verdict("h", 22, "SHA256:abc"), Verdict::Known);
        assert_eq!(store.verdict("h", 22, "SHA256:bbb"), Verdict::Changed);
        assert!(KnownHostsStore::load(dir.path().to_path_buf())
            .reset_at()
            .is_some());
    }

    #[test]
    fn dismissing_the_reset_makes_unknown_hosts_first_contacts_again() {
        let dir = tempdir().unwrap();
        let store = load_reset_store(dir.path());
        store.trust("h", 22, ed25519("SHA256:abc")).unwrap();

        store.dismiss_reset().unwrap();

        assert_eq!(store.reset_at(), None);
        assert_eq!(store.verdict("other", 22, "SHA256:x"), Verdict::Unknown);
        let restarted = KnownHostsStore::load(dir.path().to_path_buf());
        assert_eq!(restarted.reset_at(), None);
        assert_eq!(restarted.verdict("h", 22, "SHA256:abc"), Verdict::Known);
    }

    #[test]
    fn reload_picks_up_a_reset_dismissed_by_another_instance() {
        let dir = tempdir().unwrap();
        let store = load_reset_store(dir.path());
        KnownHostsStore::load(dir.path().to_path_buf())
            .dismiss_reset()
            .unwrap();

        store.reload();

        assert_eq!(store.reset_at(), None);
    }

    #[test]
    fn a_failed_dismiss_keeps_the_reset() {
        let dir = tempdir().unwrap();
        let store = load_reset_store(dir.path());
        // The store's dir turned into a file: every write now fails.
        fs::remove_dir_all(dir.path()).unwrap();
        fs::write(dir.path(), "").unwrap();

        assert!(store.dismiss_reset().is_err());

        assert!(store.reset_at().is_some());
        assert_eq!(store.verdict("h", 22, "SHA256:x"), Verdict::Unverifiable);
        fs::remove_file(dir.path()).unwrap();
    }

    // -- unreadable file ----------------------------------------------------

    /// A file that can't be read (e.g. locked by an antivirus) may hold every
    /// trusted key: unknown hosts can't be told apart from changed ones, and
    /// nothing may overwrite it.
    fn load_unreadable_store(dir: &Path) -> KnownHostsStore {
        fs::create_dir(dir.join(KNOWN_HOSTS_FILE)).unwrap();
        KnownHostsStore::load(dir.to_path_buf())
    }

    #[test]
    fn an_unreadable_file_leaves_unknown_hosts_unverifiable() {
        let dir = tempdir().unwrap();
        let store = load_unreadable_store(dir.path());

        assert_eq!(store.verdict("h", 22, "SHA256:x"), Verdict::Unverifiable);
    }

    #[test]
    fn an_unreadable_file_is_never_overwritten() {
        let dir = tempdir().unwrap();
        let store = load_unreadable_store(dir.path());

        assert!(store.trust("h", 22, ed25519("SHA256:abc")).is_err());
        assert!(store.forget("h:22").is_err());

        assert!(dir.path().join(KNOWN_HOSTS_FILE).is_dir());
    }

    #[test]
    fn a_file_readable_again_is_loaded_before_trusting() {
        let dir = tempdir().unwrap();
        let store = load_unreadable_store(dir.path());
        fs::remove_dir(dir.path().join(KNOWN_HOSTS_FILE)).unwrap();
        KnownHostsStore::load(dir.path().to_path_buf())
            .trust("old", 22, ed25519("SHA256:old"))
            .unwrap();

        store.trust("h", 22, ed25519("SHA256:abc")).unwrap();

        let reloaded = KnownHostsStore::load(dir.path().to_path_buf());
        assert_eq!(reloaded.verdict("old", 22, "SHA256:old"), Verdict::Known);
        assert_eq!(reloaded.verdict("h", 22, "SHA256:abc"), Verdict::Known);
        assert_eq!(store.verdict("other", 22, "SHA256:x"), Verdict::Unknown);
    }

    // -- reload: multi-instance sync ---------------------------------------

    #[test]
    fn reload_picks_up_trust_and_forget_from_another_instance() {
        let dir = tempdir().unwrap();
        let store = KnownHostsStore::load(dir.path().to_path_buf());
        store.trust("h", 22, ed25519("SHA256:abc")).unwrap();
        assert_eq!(store.verdict("h", 22, "SHA256:abc"), Verdict::Known);

        // A second instance trusts a new host and forgets the first.
        let other = KnownHostsStore::load(dir.path().to_path_buf());
        other.trust("h2", 22, ed25519("SHA256:def")).unwrap();
        other.forget("h:22").unwrap();

        // Stale until reloaded: still knows the now-forgotten host, unaware of h2.
        assert_eq!(store.verdict("h", 22, "SHA256:abc"), Verdict::Known);
        assert_eq!(store.verdict("h2", 22, "SHA256:def"), Verdict::Unknown);

        store.reload();

        assert_eq!(store.verdict("h", 22, "SHA256:abc"), Verdict::Unknown);
        assert_eq!(store.verdict("h2", 22, "SHA256:def"), Verdict::Known);
    }

    #[test]
    fn reload_recovers_to_empty_when_the_file_disappears() {
        let dir = tempdir().unwrap();
        let store = KnownHostsStore::load(dir.path().to_path_buf());
        store.trust("h", 22, ed25519("SHA256:abc")).unwrap();

        fs::remove_file(dir.path().join(KNOWN_HOSTS_FILE)).unwrap();
        store.reload();

        assert_eq!(store.verdict("h", 22, "SHA256:abc"), Verdict::Unknown);
    }
}
