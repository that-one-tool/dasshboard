//! Folder transfers: walk a tree and transfer each entry, skipping the ones
//! that can't or mustn't be copied.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use russh_sftp::protocol::FileType;

use super::manager::{SftpConn, SftpManager, TransferGuard};
use super::names::{is_storable_name, join_remote};
use super::transfer::{download_to_file, upload_from_file, PartialUpload};
use super::{cancelled, sftp_err};
use crate::error::AppError;

impl SftpManager {
    /// Recursively download a remote directory tree into `local_dir` (which the
    /// caller has already created/renamed per the chosen conflict policy). With
    /// `skip_existing`, local files that already exist are left untouched (a
    /// merge); otherwise they are overwritten. One cancel flag covers the whole
    /// walk. Returns the remote paths of the entries skipped: links to folders
    /// (not descended, mirroring `remove_recursive`), broken links, special
    /// files (devices, FIFOs), and names this computer can't store.
    pub async fn download_dir(
        &self,
        device_id: &str,
        remote_dir: &str,
        local_dir: &Path,
        skip_existing: bool,
        on_progress: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> Result<Vec<String>, AppError> {
        let conn = self.conn_of(device_id)?;
        let cancel = self.begin_transfer(device_id);
        let _guard = TransferGuard {
            manager: self,
            device_id: device_id.to_string(),
        };
        let transfer = FolderTransfer {
            conn: &conn,
            skip_existing,
            cancel: &cancel,
            on_progress,
        };
        download_tree(&transfer, remote_dir, local_dir).await
    }

    /// Recursively upload a local directory tree into `remote_dir` (already
    /// created/renamed by the caller per policy). With `skip_existing`, remote
    /// files that already exist are left untouched; otherwise overwritten. Local
    /// symlinks are skipped, and so are names that aren't valid Unicode, which
    /// are returned. One cancel flag covers the whole walk.
    pub async fn upload_dir(
        &self,
        device_id: &str,
        local_dir: &Path,
        remote_dir: &str,
        skip_existing: bool,
        on_progress: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> Result<Vec<String>, AppError> {
        let conn = self.conn_of(device_id)?;
        let cancel = self.begin_transfer(device_id);
        let _guard = TransferGuard {
            manager: self,
            device_id: device_id.to_string(),
        };
        let transfer = FolderTransfer {
            conn: &conn,
            skip_existing,
            cancel: &cancel,
            on_progress,
        };
        upload_tree(&transfer, local_dir, remote_dir).await
    }
}

/// Recursively download `remote_dir` into `local_dir`, boxed so the `async fn`
/// can recurse. Creates each local directory, then downloads files (skipping
/// existing ones when `skip_existing`). Checks `cancel` before each entry.
/// Returns the remote paths of the entries it skipped (see [`entry_action`]),
/// so one odd entry never stops the rest of the download.
fn download_tree<'a>(
    transfer: &'a FolderTransfer<'a>,
    remote_dir: &'a str,
    local_dir: &'a Path,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<String>, AppError>> + Send + 'a>>
{
    Box::pin(async move {
        let conn = transfer.conn;
        create_local_dir(local_dir).await?;
        let read_dir = conn
            .session
            .read_dir(remote_dir.to_string())
            .await
            .map_err(|e| sftp_err(&format!("could not list {remote_dir}"), e))?;
        let mut skipped = Vec::new();
        for entry in read_dir {
            if transfer.is_cancelled() {
                return Err(cancelled());
            }
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let remote_child = join_remote(remote_dir, &name);
            let local_child = local_dir.join(&name);
            match entry_action(conn, entry.file_type(), &name, &remote_child).await {
                EntryAction::Skip => skipped.push(remote_child),
                EntryAction::Descend => {
                    skipped.extend(download_tree(transfer, &remote_child, &local_child).await?)
                }
                EntryAction::Fetch => fetch_file(transfer, &remote_child, &local_child).await?,
            }
        }
        Ok(skipped)
    })
}

/// Ensure a local directory exists (blocking FS off the async runtime).
async fn create_local_dir(local_dir: &Path) -> Result<(), AppError> {
    let make = local_dir.to_path_buf();
    let disp = local_dir.display().to_string();
    tokio::task::spawn_blocking(move || std::fs::create_dir_all(&make))
        .await
        .map_err(|e| AppError::Io(format!("mkdir task failed: {e}")))?
        .map_err(|e| AppError::Io(format!("could not create {disp}: {e}")))
}

/// One folder transfer: its connection, whether existing files are left
/// alone, and the cancel flag and progress callback every file shares.
struct FolderTransfer<'a> {
    conn: &'a Arc<SftpConn>,
    skip_existing: bool,
    cancel: &'a Arc<AtomicBool>,
    on_progress: &'a (dyn Fn(u64, u64) + Send + Sync),
}

impl FolderTransfer<'_> {
    fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

/// What a folder download does with one directory entry.
enum EntryAction {
    Descend,
    Fetch,
    Skip,
}

/// Skips a name this computer can't store as is (see [`is_storable_name`]);
/// otherwise acts on the entry's type, following a symlink one level.
async fn entry_action(
    conn: &SftpConn,
    file_type: FileType,
    name: &str,
    remote_child: &str,
) -> EntryAction {
    if !is_storable_name(name) {
        return EntryAction::Skip;
    }
    if file_type.is_symlink() {
        return link_action(conn, remote_child).await;
    }
    type_action(&file_type)
}

/// Folders are descended and regular files fetched; anything else (a device,
/// a FIFO, a socket) is skipped: `/dev/zero` would fill the disk, a FIFO hang
/// the transfer.
fn type_action(file_type: &FileType) -> EntryAction {
    match file_type {
        FileType::Dir => EntryAction::Descend,
        FileType::File => EntryAction::Fetch,
        _ => EntryAction::Skip,
    }
}

/// A symlink is fetched as the regular file it points to. One pointing to a
/// folder (not followed: no cycles, no tree copied twice), to a special file,
/// or nowhere is skipped.
async fn link_action(conn: &SftpConn, remote_child: &str) -> EntryAction {
    match conn.session.metadata(remote_child.to_string()).await {
        Ok(target) if target.is_regular() => EntryAction::Fetch,
        _ => EntryAction::Skip,
    }
}

/// Downloads one file of a folder download, leaving an existing local file
/// alone when `skip_existing`.
async fn fetch_file(
    transfer: &FolderTransfer<'_>,
    remote_path: &str,
    local_path: &Path,
) -> Result<(), AppError> {
    if transfer.skip_existing {
        let probe = local_path.to_path_buf();
        let exists = tokio::task::spawn_blocking(move || probe.exists())
            .await
            .map_err(|e| AppError::Io(format!("stat task failed: {e}")))?;
        if exists {
            return Ok(());
        }
    }
    // Stream straight to disk — no whole-file buffer per entry.
    let (conn, cancel) = (transfer.conn, transfer.cancel);
    download_to_file(conn, remote_path, local_path, cancel, transfer.on_progress).await?;
    Ok(())
}

/// One local entry discovered while walking a directory to upload — a POSIX-style
/// path relative to the upload root, with parents ordered before their children.
struct LocalWalkEntry {
    rel: String,
    is_dir: bool,
}

/// What a walk of a local directory to upload found.
#[derive(Default)]
struct LocalWalk {
    entries: Vec<LocalWalkEntry>,
    /// Relative paths (shown lossily) of entries whose name isn't valid
    /// Unicode, skipped with anything under them: an SFTP path is a string.
    skipped: Vec<String>,
}

/// Walk a local directory top-down (parents before children), collecting
/// directories and regular files (symlinks are skipped so the upload can't
/// follow a link out of the tree or into a cycle).
fn walk_local(root: &Path) -> std::io::Result<LocalWalk> {
    let mut walk = LocalWalk::default();
    walk_local_dir(root, "", &mut walk)?;
    Ok(walk)
}

fn walk_local_dir(dir: &Path, prefix: &str, walk: &mut LocalWalk) -> std::io::Result<()> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        walk_local_entry(&entry, prefix, walk)?;
    }
    Ok(())
}

fn walk_local_entry(
    entry: &std::fs::DirEntry,
    prefix: &str,
    walk: &mut LocalWalk,
) -> std::io::Result<()> {
    let name = entry.file_name();
    let Some(name) = name.to_str() else {
        walk.skipped
            .push(join_relative(prefix, &name.to_string_lossy()));
        return Ok(());
    };
    let rel = join_relative(prefix, name);
    let file_type = entry.file_type()?;
    if file_type.is_dir() {
        walk.entries.push(LocalWalkEntry {
            rel: rel.clone(),
            is_dir: true,
        });
        walk_local_dir(&entry.path(), &rel, walk)?;
    } else if file_type.is_file() {
        walk.entries.push(LocalWalkEntry { rel, is_dir: false });
    }
    Ok(())
}

fn join_relative(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}/{name}")
    }
}

/// Recursively upload `local_dir` into `remote_dir`: create each remote
/// subdirectory (ignoring an already-exists error), then upload files (skipping
/// existing ones when `skip_existing`). Checks `cancel` before each entry.
/// Returns the relative paths of the entries it had to skip (see
/// [`LocalWalk::skipped`]).
async fn upload_tree(
    transfer: &FolderTransfer<'_>,
    local_dir: &Path,
    remote_dir: &str,
) -> Result<Vec<String>, AppError> {
    let conn = transfer.conn;
    let root = local_dir.to_path_buf();
    let disp = local_dir.display().to_string();
    let walk = tokio::task::spawn_blocking(move || walk_local(&root))
        .await
        .map_err(|e| AppError::Io(format!("upload walk task failed: {e}")))?
        .map_err(|e| AppError::Io(format!("could not read {disp}: {e}")))?;

    for entry in walk.entries {
        if transfer.is_cancelled() {
            return Err(cancelled());
        }
        let remote_child = join_remote(remote_dir, &entry.rel);
        if entry.is_dir {
            // Create the remote subdirectory; an already-exists error is benign
            // (a real failure surfaces when a file upload into it fails).
            let _ = conn.session.create_dir(remote_child).await;
        } else {
            if transfer.skip_existing && conn.session.metadata(remote_child.clone()).await.is_ok() {
                continue;
            }
            let local_file = local_dir.join(&entry.rel);
            // Stream straight from disk — no whole-file buffer per entry.
            upload_from_file(
                conn,
                &local_file,
                &remote_child,
                PartialUpload::Remove,
                transfer.cancel,
                transfer.on_progress,
            )
            .await?;
        }
    }
    Ok(walk.skipped)
}
