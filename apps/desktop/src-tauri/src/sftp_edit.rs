//! Edit a remote file in place: the Files panel downloads it into a private
//! local directory, an external editor opens the copy, and each save is
//! uploaded back over the original.
//!
//! An [`EditManager`] owns the open edits, keyed by an edit id. Each edit has:
//! - its own `0700` directory under the manager's base dir: a `copy/` folder
//!   holding the copy under the remote file's (sanitized) name, so the editor
//!   picks the right syntax mode, and scratch files that every download and
//!   upload goes through, so each digest is of exactly the bytes transferred;
//! - a debounced `notify` watcher on `copy/` — on the folder, not the file,
//!   because many editors save by writing a temp file and renaming it over the
//!   original, which a watch on the old inode would miss;
//! - the sync baseline: the remote [`RemoteStamp`] and the digest of the local
//!   content as of the last download/upload. A save whose content matches the
//!   digest needs no upload; a remote whose stamp moved is a conflict.
//!
//! Like `sftp.rs`, this module is Tauri-free: transfers go through the
//! [`SftpManager`] passed into each call, and a change is reported through an
//! [`EditSink`].

use std::collections::HashMap;
use std::hash::Hasher;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, SystemTime};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;

use crate::error::AppError;
use crate::sftp::{RemoteStamp, SftpManager};

/// Coalesces the burst of events one save produces (write + rename + chmod)
/// into one notification.
const DEBOUNCE: Duration = Duration::from_millis(500);

/// Name used when the remote name sanitizes to nothing usable.
const FALLBACK_NAME: &str = "file";

/// Inside an edit's directory: the folder holding the copy (the only one
/// watched), and the scratch files transfers go through beside it.
const COPY_DIR: &str = "copy";
const DOWNLOAD_SCRATCH: &str = "download.tmp";
const UPLOAD_SCRATCH: &str = "upload.tmp";
/// Locked by the owning instance for as long as the edit lives (see
/// [`is_in_use`]).
const LOCK_FILE: &str = "lock";

/// Copies untouched for this long are leftovers of a crash (see
/// [`sweep_stale_copies`]).
pub const STALE_COPY_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// Receives a debounced "the local copy changed on disk" per edit.
pub trait EditSink: Send + Sync {
    fn on_local_change(&self, edit_id: &str);
}

/// What the frontend shows for an open edit. Non-secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditInfo {
    pub edit_id: String,
    pub device_id: String,
    pub remote_path: String,
    /// Base name of the remote file.
    pub name: String,
}

/// Whether a saved local copy needs uploading, and whether that is safe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EditCheck {
    /// The local content matches what was last synced: nothing to upload.
    Unchanged,
    /// Local changes, remote untouched since the last sync: safe to upload.
    Clean,
    /// Local changes, and the remote file changed too.
    Conflict,
}

/// The result of an upload attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EditUpload {
    Uploaded,
    /// Nothing to upload (the content matches the last sync).
    Unchanged,
    /// Not uploaded: the remote changed and overwriting was not requested.
    Conflict,
}

/// The last point at which the local copy and the remote file were in sync.
/// `remote` is `None` after an upload that failed or could not be confirmed:
/// the remote then holds our own (maybe partial) write, so the next save
/// uploads again instead of reporting a conflict.
#[derive(Debug, Clone, Copy)]
struct Baseline {
    remote: Option<RemoteStamp>,
    digest: u64,
}

/// A downloaded or about-to-be-uploaded snapshot: a scratch file beside the
/// watched folder, and the digest of exactly its bytes.
struct Snapshot {
    path: PathBuf,
    digest: u64,
}

struct EditSession {
    info: EditInfo,
    dir: EditDir,
    local_path: PathBuf,
    baseline: Mutex<Baseline>,
    /// Held only to keep the watch alive; dropping it ends the watch thread.
    _watcher: RecommendedWatcher,
}

impl EditSession {
    fn baseline(&self) -> Baseline {
        *self.baseline.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn set_baseline(&self, baseline: Baseline) {
        *self.baseline.lock().unwrap_or_else(|p| p.into_inner()) = baseline;
    }

    fn forget_remote(&self) {
        self.baseline
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remote = None;
    }

    fn scratch(&self, name: &str) -> PathBuf {
        self.dir.path.join(name)
    }
}

/// An edit's private directory: locked while the edit lives, so another
/// instance's startup sweep leaves it alone, and removed with it — also when
/// setting the edit up fails.
struct EditDir {
    path: PathBuf,
    /// Released before the directory is removed: Windows can't remove a
    /// folder holding an open file.
    lock: Option<std::fs::File>,
}

impl EditDir {
    fn create(path: PathBuf) -> Result<Self, AppError> {
        create_private_dir(&path.join(COPY_DIR))?;
        let lock = lock_edit_dir(&path);
        Ok(Self { path, lock })
    }
}

impl Drop for EditDir {
    fn drop(&mut self) {
        drop(self.lock.take());
        remove_logged(&self.path);
    }
}

/// Best effort: on a filesystem without locks the edit still works, only
/// unprotected from a sweep (which needs it untouched for a day anyway).
fn lock_edit_dir(dir: &Path) -> Option<std::fs::File> {
    let file = std::fs::File::create(dir.join(LOCK_FILE)).ok()?;
    let _ = file.try_lock();
    Some(file)
}

/// Whether a running instance holds the edit directory's lock. A crash
/// releases it, so a crash's leftovers read as not in use.
fn is_in_use(dir: &Path) -> bool {
    std::fs::File::open(dir.join(LOCK_FILE))
        .is_ok_and(|file| matches!(file.try_lock(), Err(std::fs::TryLockError::WouldBlock)))
}

pub struct EditManager {
    base_dir: PathBuf,
    edits: Mutex<HashMap<String, Arc<EditSession>>>,
}

impl EditManager {
    /// `base_dir` is created on the first edit, private to the user.
    pub fn new(base_dir: PathBuf) -> Self {
        Self {
            base_dir,
            edits: Mutex::new(HashMap::new()),
        }
    }

    fn lock_edits(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<EditSession>>> {
        self.edits.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn edit_of(&self, edit_id: &str) -> Result<Arc<EditSession>, AppError> {
        self.lock_edits()
            .get(edit_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("no open edit {edit_id}")))
    }

    /// Download `remote_path` into a fresh private directory and start watching
    /// it. The remote stamp is taken before the download, so a change racing
    /// the download shows up as a (false) conflict rather than being missed.
    pub async fn open(
        &self,
        sftp: &SftpManager,
        device_id: &str,
        remote_path: &str,
        sink: Arc<dyn EditSink>,
        on_progress: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> Result<EditInfo, AppError> {
        let remote = sftp.remote_stamp(device_id, remote_path).await?;
        let edit_id = uuid::Uuid::new_v4().to_string();
        let dir = EditDir::create(self.base_dir.join(&edit_id))?;
        let name = remote_base_name(remote_path).to_string();
        let local_path = dir.path.join(COPY_DIR).join(local_edit_name(&name));
        let scratch = dir.path.join(DOWNLOAD_SCRATCH);
        let digest = download_into(
            sftp,
            device_id,
            remote_path,
            &scratch,
            &local_path,
            on_progress,
        )
        .await?;
        let watcher = watch_local_copy(&local_path, &edit_id, sink)?;
        let info = EditInfo {
            edit_id,
            device_id: device_id.to_string(),
            remote_path: remote_path.to_string(),
            name,
        };
        self.register(
            sftp,
            EditSession {
                info: info.clone(),
                dir,
                local_path,
                baseline: Mutex::new(Baseline {
                    remote: Some(remote),
                    digest,
                }),
                _watcher: watcher,
            },
        )?;
        Ok(info)
    }

    /// Add a ready edit — unless its connection closed meanwhile, in which case
    /// `close_device` already ran and the edit would outlive it. Checked under
    /// the edits lock, which `close_device` takes after the connection is gone.
    fn register(&self, sftp: &SftpManager, session: EditSession) -> Result<(), AppError> {
        let mut edits = self.lock_edits();
        if !sftp.is_connected(&session.info.device_id) {
            return Err(AppError::NotFound(
                "the SFTP connection closed while opening the file".into(),
            ));
        }
        edits.insert(session.info.edit_id.clone(), Arc::new(session));
        Ok(())
    }

    /// The edit's device and remote file.
    pub fn info(&self, edit_id: &str) -> Result<EditInfo, AppError> {
        Ok(self.edit_of(edit_id)?.info.clone())
    }

    /// The local copy an editor should open.
    pub fn local_path(&self, edit_id: &str) -> Result<PathBuf, AppError> {
        Ok(self.edit_of(edit_id)?.local_path.clone())
    }

    /// Compare the local copy and the remote file against the last sync.
    pub async fn check(&self, sftp: &SftpManager, edit_id: &str) -> Result<EditCheck, AppError> {
        let edit = self.edit_of(edit_id)?;
        let baseline = edit.baseline();
        if file_digest(&edit.local_path).await? == baseline.digest {
            return Ok(EditCheck::Unchanged);
        }
        Ok(if remote_moved(sftp, &edit, baseline).await? {
            EditCheck::Conflict
        } else {
            EditCheck::Clean
        })
    }

    /// Upload the local copy over the remote file, unless it is unchanged, or
    /// the remote changed and `overwrite` is false. What goes up is a snapshot
    /// of the copy, so the recorded digest is exactly what the remote holds; a
    /// save landing meanwhile differs from it and triggers another upload.
    pub async fn upload(
        &self,
        sftp: &SftpManager,
        edit_id: &str,
        overwrite: bool,
        on_progress: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> Result<EditUpload, AppError> {
        let edit = self.edit_of(edit_id)?;
        let snapshot = take_snapshot(&edit.local_path, &edit.scratch(UPLOAD_SCRATCH)).await?;
        let outcome = upload_snapshot(sftp, &edit, &snapshot, overwrite, on_progress).await;
        let _ = tokio::fs::remove_file(&snapshot.path).await;
        outcome
    }

    /// Throw away the local changes: download the remote file again over the
    /// local copy (an atomic replace, which editors notice and reload).
    pub async fn discard(
        &self,
        sftp: &SftpManager,
        edit_id: &str,
        on_progress: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> Result<(), AppError> {
        let edit = self.edit_of(edit_id)?;
        let (device_id, remote_path) = (&edit.info.device_id, &edit.info.remote_path);
        let remote = sftp.remote_stamp(device_id, remote_path).await?;
        let scratch = edit.scratch(DOWNLOAD_SCRATCH);
        let digest = download_into(
            sftp,
            device_id,
            remote_path,
            &scratch,
            &edit.local_path,
            on_progress,
        )
        .await?;
        edit.set_baseline(Baseline {
            remote: Some(remote),
            digest,
        });
        Ok(())
    }

    /// Stop watching an edit and delete its local copy. Unknown ids are a no-op.
    pub fn close(&self, edit_id: &str) {
        let removed = self.lock_edits().remove(edit_id);
        drop(removed);
    }

    /// Close every edit of one device. Call it after the device's connection
    /// is gone (see [`register`](Self::register)).
    pub fn close_device(&self, device_id: &str) {
        self.lock_edits()
            .retain(|_, edit| edit.info.device_id != device_id);
    }

    /// Close every edit (app shutdown).
    pub fn close_all(&self) {
        self.lock_edits().clear();
    }
}

/// Whether the remote file moved since the baseline. A remote we last wrote
/// ourselves without confirming it (`None`) never counts as moved.
async fn remote_moved(
    sftp: &SftpManager,
    edit: &EditSession,
    baseline: Baseline,
) -> Result<bool, AppError> {
    let Some(stamp) = baseline.remote else {
        return Ok(false);
    };
    let now = sftp
        .remote_stamp(&edit.info.device_id, &edit.info.remote_path)
        .await?;
    Ok(now != stamp)
}

async fn upload_snapshot(
    sftp: &SftpManager,
    edit: &EditSession,
    snapshot: &Snapshot,
    overwrite: bool,
    on_progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<EditUpload, AppError> {
    let baseline = edit.baseline();
    if snapshot.digest == baseline.digest {
        return Ok(EditUpload::Unchanged);
    }
    if !overwrite && remote_moved(sftp, edit, baseline).await? {
        return Ok(EditUpload::Conflict);
    }
    write_back(sftp, edit, snapshot, on_progress).await?;
    Ok(EditUpload::Uploaded)
}

/// Upload the snapshot and move the baseline to it. On failure the remote may
/// hold part of it, so it stops being compared (see [`Baseline`]).
async fn write_back(
    sftp: &SftpManager,
    edit: &EditSession,
    snapshot: &Snapshot,
    on_progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<(), AppError> {
    let (device_id, remote_path) = (&edit.info.device_id, &edit.info.remote_path);
    let written = sftp
        .overwrite_from_path(device_id, &snapshot.path, remote_path, on_progress)
        .await;
    if let Err(e) = written {
        edit.forget_remote();
        return Err(e);
    }
    let remote = sftp.remote_stamp(device_id, remote_path).await.ok();
    edit.set_baseline(Baseline {
        remote,
        digest: snapshot.digest,
    });
    Ok(())
}

/// Download the remote file into `scratch`, digest it, then move it over
/// `local_path` — so the digest is of exactly the downloaded bytes even if an
/// editor saves right after the replace.
async fn download_into(
    sftp: &SftpManager,
    device_id: &str,
    remote_path: &str,
    scratch: &Path,
    local_path: &Path,
    on_progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<u64, AppError> {
    sftp.download_to_path(device_id, remote_path, scratch, on_progress)
        .await?;
    let digest = file_digest(scratch).await?;
    tokio::fs::rename(scratch, local_path)
        .await
        .map_err(|e| AppError::Io(format!("could not replace {}: {e}", local_path.display())))?;
    Ok(digest)
}

/// Copy the local copy to `scratch` and digest the copy.
async fn take_snapshot(local_path: &Path, scratch: &Path) -> Result<Snapshot, AppError> {
    tokio::fs::copy(local_path, scratch)
        .await
        .map_err(|e| AppError::Io(format!("could not read {}: {e}", local_path.display())))?;
    let digest = file_digest(scratch).await?;
    Ok(Snapshot {
        path: scratch.to_path_buf(),
        digest,
    })
}

/// Create `dir` (and missing parents) readable only by the current user: the
/// copy may hold secrets from a remote config file.
fn create_private_dir(dir: &Path) -> Result<(), AppError> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(dir)
        .map_err(|e| AppError::Io(format!("could not create {}: {e}", dir.display())))
}

/// Delete an edit's directory, logging a failure (on Windows an editor that
/// still holds the copy open blocks it; the startup sweep retries later).
fn remove_logged(dir: &Path) {
    match std::fs::remove_dir_all(dir) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            eprintln!("[DaSSHboard] could not delete the edit copy {dir:?}: {e}");
        }
        _ => {}
    }
}

/// Delete the edit directories under `base_dir` untouched for longer than
/// `older_than` and not locked by a running instance (which shares
/// `base_dir`): copies left behind by a crash.
pub fn sweep_stale_copies(base_dir: &Path, older_than: Duration) {
    let Ok(entries) = std::fs::read_dir(base_dir) else {
        return;
    };
    let now = SystemTime::now();
    for dir in entries.flatten().map(|e| e.path()) {
        if is_stale(&dir, now, older_than) && !is_in_use(&dir) {
            remove_logged(&dir);
        }
    }
}

fn is_stale(dir: &Path, now: SystemTime, older_than: Duration) -> bool {
    let last_touched = newest_mtime(dir).unwrap_or(SystemTime::UNIX_EPOCH);
    now.duration_since(last_touched).unwrap_or_default() > older_than
}

/// The latest modification time of an edit directory, its `copy/` folder and
/// the copy itself — a save touches one of them.
fn newest_mtime(dir: &Path) -> Option<SystemTime> {
    let copies = std::fs::read_dir(dir.join(COPY_DIR))
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path());
    [dir.to_path_buf(), dir.join(COPY_DIR)]
        .into_iter()
        .chain(copies)
        .filter_map(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
        .max()
}

/// A non-cryptographic content digest, only ever compared with another digest
/// of the same file to tell "saved with changes" from "saved as is".
async fn file_digest(path: &Path) -> Result<u64, AppError> {
    let owned = path.to_path_buf();
    tokio::task::spawn_blocking(move || digest_blocking(&owned))
        .await
        .map_err(|e| AppError::Io(format!("digest task failed: {e}")))?
        .map_err(|e| AppError::Io(format!("could not read {}: {e}", path.display())))
}

fn digest_blocking(path: &Path) -> std::io::Result<u64> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut chunk)?;
        if n == 0 {
            return Ok(hasher.finish());
        }
        hasher.write(&chunk[..n]);
    }
}

/// Watch the folder holding the copy and report debounced changes to it.
fn watch_local_copy(
    local_path: &Path,
    edit_id: &str,
    sink: Arc<dyn EditSink>,
) -> Result<RecommendedWatcher, AppError> {
    let watch_err =
        |e: notify::Error| AppError::Io(format!("could not watch the edited file: {e}"));
    let (tx, rx) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(event) = res {
            let _ = tx.send(event);
        }
    })
    .map_err(watch_err)?;
    let folder = local_path.parent().unwrap_or(local_path);
    watcher
        .watch(folder, RecursiveMode::NonRecursive)
        .map_err(watch_err)?;
    let file_name = local_path.file_name().unwrap_or_default().to_os_string();
    let edit_id = edit_id.to_string();
    std::thread::Builder::new()
        .name("sftp-edit-watch".into())
        .spawn(move || {
            debounce_changes(
                &rx,
                |e| touches(e, &file_name),
                || sink.on_local_change(&edit_id),
            )
        })
        .map_err(|e| AppError::Io(format!("could not start the edit watcher: {e}")))?;
    Ok(watcher)
}

/// How a burst of watcher events ended.
enum Burst {
    Changed,
    Quiet,
    /// The watcher was dropped: stop.
    Closed,
}

/// Call `fire` once per burst of relevant events, after the burst has been
/// quiet for [`DEBOUNCE`]. Returns when the watcher (the sender) is dropped.
fn debounce_changes(
    rx: &mpsc::Receiver<Event>,
    relevant: impl Fn(&Event) -> bool,
    fire: impl Fn(),
) {
    loop {
        match next_burst(rx, &relevant) {
            Burst::Changed => fire(),
            Burst::Quiet => {}
            Burst::Closed => return,
        }
    }
}

fn next_burst(rx: &mpsc::Receiver<Event>, relevant: &impl Fn(&Event) -> bool) -> Burst {
    let Ok(first) = rx.recv() else {
        return Burst::Closed;
    };
    settle(rx, relevant, relevant(&first))
}

/// Keep absorbing events until none arrives for [`DEBOUNCE`].
fn settle(
    rx: &mpsc::Receiver<Event>,
    relevant: &impl Fn(&Event) -> bool,
    mut changed: bool,
) -> Burst {
    loop {
        match rx.recv_timeout(DEBOUNCE) {
            Ok(event) => changed |= relevant(&event),
            Err(mpsc::RecvTimeoutError::Timeout) => return burst_of(changed),
            Err(mpsc::RecvTimeoutError::Disconnected) => return Burst::Closed,
        }
    }
}

fn burst_of(changed: bool) -> Burst {
    if changed {
        Burst::Changed
    } else {
        Burst::Quiet
    }
}

/// Whether an event may have changed the file named `file_name`. Reads are
/// ignored, and so are the editor's own scratch files (`.swp`, `name~`, …).
fn touches(event: &Event, file_name: &std::ffi::OsStr) -> bool {
    !matches!(event.kind, EventKind::Access(_))
        && event.paths.iter().any(|p| p.file_name() == Some(file_name))
}

/// The last component of a POSIX remote path.
fn remote_base_name(remote_path: &str) -> &str {
    remote_path.rsplit('/').next().unwrap_or(remote_path)
}

/// A local file name for a remote base name: shell metacharacters become `_`
/// (the copy's path may be spliced into a user's `sh -c "… {file}"` editor
/// command), then made [`windows_portable_name`].
fn local_edit_name(remote_name: &str) -> String {
    let inert: String = remote_name.chars().map(shell_inert_char).collect();
    windows_portable_name(&inert)
}

/// Characters that end or extend a word, quote, or substitute in `sh`,
/// PowerShell or `cmd`.
const SHELL_METACHARACTERS: &str = "$`;&|()<>!'\"\\{}^%";

fn shell_inert_char(c: char) -> char {
    if SHELL_METACHARACTERS.contains(c) {
        '_'
    } else {
        c
    }
}

/// `name` made valid on every desktop OS: characters Windows forbids become
/// `_`, trailing dots/spaces (dropped by Windows) are trimmed, reserved device
/// names get a `_` prefix, and an empty or dot-only result falls back to
/// [`FALLBACK_NAME`].
fn windows_portable_name(name: &str) -> String {
    let replaced: String = name.chars().map(portable_char).collect();
    let trimmed = replaced.trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        return FALLBACK_NAME.to_string();
    }
    if is_reserved_windows_name(trimmed) {
        return format!("_{trimmed}");
    }
    trimmed.to_string()
}

/// Whether Windows can store a file under `name` as is: the name
/// [`windows_portable_name`] would leave unchanged.
pub(crate) fn is_windows_portable_name(name: &str) -> bool {
    windows_portable_name(name) == name
}

fn portable_char(c: char) -> char {
    if c.is_control() || "<>:\"/\\|?*".contains(c) {
        '_'
    } else {
        c
    }
}

/// `CON`, `NUL`, `COM1`, … (with or without an extension) name devices on
/// Windows, whatever the case.
fn is_reserved_windows_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    const DEVICES: [&str; 4] = ["CON", "PRN", "AUX", "NUL"];
    DEVICES.contains(&stem.as_str()) || is_numbered_port(&stem)
}

/// `COM1`…`COM9`, `LPT1`…`LPT9` (upper case).
fn is_numbered_port(stem: &str) -> bool {
    match stem.as_bytes() {
        [b'C', b'O', b'M', digit] | [b'L', b'P', b'T', digit] => digit.is_ascii_digit(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, CreateKind, ModifyKind};

    fn event(kind: EventKind, path: &str) -> Event {
        Event {
            kind,
            paths: vec![PathBuf::from(path)],
            attrs: Default::default(),
        }
    }

    #[test]
    fn windows_portable_names_are_the_ones_windows_can_store() {
        for name in ["report.pdf", ".bashrc", "a b", "console.log", "résumé"] {
            assert!(
                is_windows_portable_name(name),
                "{name:?} should be portable"
            );
        }
        for name in [
            "a:b", "x?", "aux", "NUL.txt", "com1", "name.", "trail ", "a\\b", "",
        ] {
            assert!(!is_windows_portable_name(name), "{name:?} must not be");
        }
    }

    #[test]
    fn remote_base_name_is_the_last_component() {
        assert_eq!(remote_base_name("/etc/nginx/nginx.conf"), "nginx.conf");
        assert_eq!(remote_base_name("relative.txt"), "relative.txt");
    }

    #[test]
    fn ordinary_names_are_kept() {
        for name in ["nginx.conf", ".bashrc", "Makefile", "résumé.md", "a b.txt"] {
            assert_eq!(local_edit_name(name), name);
        }
    }

    #[test]
    fn characters_windows_forbids_become_underscores() {
        assert_eq!(local_edit_name("a:b?c*.log"), "a_b_c_.log");
        assert_eq!(local_edit_name("x\\y|z\"<>"), "x_y_z___");
        assert_eq!(local_edit_name("tab\there"), "tab_here");
    }

    /// The copy's path can land inside a user's `sh -c "… {file}"` editor
    /// command, so a remote name must not be able to carry shell syntax.
    #[test]
    fn shell_metacharacters_become_underscores() {
        assert_eq!(local_edit_name("x$(id).conf"), "x__id_.conf");
        assert_eq!(local_edit_name("a;b&c|d`e`"), "a_b_c_d_e_");
        assert_eq!(local_edit_name("it's {x} 5%^!.txt"), "it_s _x_ 5___.txt");
    }

    #[test]
    fn shell_metacharacters_are_still_windows_portable() {
        assert!(is_windows_portable_name("a$b;c'd"));
    }

    #[test]
    fn trailing_dots_and_spaces_are_trimmed() {
        assert_eq!(local_edit_name("notes. "), "notes");
    }

    #[test]
    fn unusable_names_fall_back() {
        for name in ["", ".", "..", " "] {
            assert_eq!(local_edit_name(name), FALLBACK_NAME);
        }
    }

    #[test]
    fn reserved_device_names_are_prefixed() {
        assert_eq!(local_edit_name("con"), "_con");
        assert_eq!(local_edit_name("NUL.txt"), "_NUL.txt");
        assert_eq!(local_edit_name("com1.log"), "_com1.log");
        assert_eq!(local_edit_name("console.log"), "console.log");
        assert_eq!(local_edit_name("COMA"), "COMA");
    }

    #[test]
    fn writes_and_renames_onto_the_file_count_as_changes() {
        let name = std::ffi::OsStr::new("app.conf");
        assert!(touches(
            &event(EventKind::Modify(ModifyKind::Any), "/d/app.conf"),
            name
        ));
        assert!(touches(
            &event(EventKind::Create(CreateKind::File), "/d/app.conf"),
            name
        ));
    }

    #[test]
    fn reads_and_other_files_are_ignored() {
        let name = std::ffi::OsStr::new("app.conf");
        assert!(!touches(
            &event(EventKind::Access(AccessKind::Any), "/d/app.conf"),
            name
        ));
        assert!(!touches(
            &event(EventKind::Modify(ModifyKind::Any), "/d/.app.conf.swp"),
            name
        ));
        assert!(!touches(
            &event(EventKind::Modify(ModifyKind::Any), "/d/app.conf.part"),
            name
        ));
    }

    fn edit_dir_in(base: &Path, name: &str) -> PathBuf {
        let dir = base.join(name);
        std::fs::create_dir_all(dir.join(COPY_DIR)).unwrap();
        std::fs::write(dir.join(COPY_DIR).join("app.conf"), b"x").unwrap();
        dir
    }

    #[test]
    fn the_sweep_removes_copies_older_than_the_limit() {
        let base = tempfile::tempdir().unwrap();
        let dir = edit_dir_in(base.path(), "old");
        std::thread::sleep(Duration::from_millis(20));

        sweep_stale_copies(base.path(), Duration::from_millis(1));

        assert!(!dir.exists());
    }

    /// Another running instance's edit can sit untouched for over a day; its
    /// lock keeps the sweep off it.
    #[test]
    fn the_sweep_spares_a_live_edit_however_old() {
        let base = tempfile::tempdir().unwrap();
        let live = EditDir::create(base.path().join("live")).unwrap();
        std::thread::sleep(Duration::from_millis(20));

        sweep_stale_copies(base.path(), Duration::from_millis(1));

        assert!(live.path.join(COPY_DIR).exists());
    }

    #[test]
    fn the_sweep_removes_a_crashed_edit_whose_lock_was_released() {
        let base = tempfile::tempdir().unwrap();
        let dir = edit_dir_in(base.path(), "crashed");
        std::fs::write(dir.join(LOCK_FILE), b"").unwrap();
        std::thread::sleep(Duration::from_millis(20));

        sweep_stale_copies(base.path(), Duration::from_millis(1));

        assert!(!dir.exists());
    }

    #[test]
    fn an_edit_dir_is_removed_when_dropped() {
        let base = tempfile::tempdir().unwrap();
        let dir = EditDir::create(base.path().join("e")).unwrap();
        let path = dir.path.clone();

        drop(dir);

        assert!(!path.exists());
    }

    #[test]
    fn the_sweep_keeps_recent_copies() {
        let base = tempfile::tempdir().unwrap();
        let dir = edit_dir_in(base.path(), "live");

        sweep_stale_copies(base.path(), STALE_COPY_AGE);

        assert!(dir.join(COPY_DIR).join("app.conf").exists());
    }

    #[test]
    fn a_missing_base_dir_is_not_an_error() {
        let base = tempfile::tempdir().unwrap();
        sweep_stale_copies(&base.path().join("nope"), STALE_COPY_AGE);
    }

    #[test]
    fn a_burst_of_events_fires_once() {
        let (tx, rx) = mpsc::channel();
        for _ in 0..3 {
            tx.send(event(EventKind::Modify(ModifyKind::Any), "/d/f"))
                .unwrap();
        }
        drop(tx);
        let fired = std::sync::atomic::AtomicUsize::new(0);
        debounce_changes(
            &rx,
            |_| true,
            || {
                fired.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            },
        );
        // The sender closed mid-burst: the watch ended, so nothing fires.
        assert_eq!(fired.into_inner(), 0);
    }

    #[test]
    fn a_quiet_burst_fires_and_irrelevant_ones_do_not() {
        let (tx, rx) = mpsc::channel();
        let fired = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = Arc::clone(&fired);
        let worker = std::thread::spawn(move || {
            debounce_changes(
                &rx,
                |e| touches(e, std::ffi::OsStr::new("f")),
                || {
                    counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                },
            )
        });
        tx.send(event(EventKind::Modify(ModifyKind::Any), "/d/f"))
            .unwrap();
        std::thread::sleep(DEBOUNCE * 2);
        tx.send(event(EventKind::Modify(ModifyKind::Any), "/d/other"))
            .unwrap();
        std::thread::sleep(DEBOUNCE * 2);
        drop(tx);
        worker.join().unwrap();
        assert_eq!(fired.load(std::sync::atomic::Ordering::Relaxed), 1);
    }
}
