//! Single-file transfers: streamed to or from a local file in constant
//! memory, or whole-file in memory for the integration tests.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use russh_sftp::client::fs::File;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::manager::{SftpConn, SftpManager, TransferGuard};
use super::{cancelled, sftp_err};
use crate::error::AppError;

/// Chunk size for streaming SFTP transfers (32 KiB). Only the network read/write
/// is chunked, so progress reflects the slow part; larger chunks reduce SFTP
/// round trips without materially coarsening the progress bar.
pub(super) const TRANSFER_CHUNK: usize = 32 * 1024;

/// What a failed upload does with the remote file it already created or
/// truncated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PartialUpload {
    /// A fresh upload: drop the incomplete file — unless it existed before
    /// (an overwrite), which is never deleted.
    Remove,
    /// An edit-in-place upload over a file the user cares about: leave it
    /// (owner, mode, links intact) so a retry can complete it.
    Keep,
}

impl SftpManager {
    /// Stream a remote file straight to `local_path`, chunk by chunk, never
    /// buffering the whole file (constant memory regardless of size). Drives
    /// `on_progress(transferred, total)` for a progress bar; `total` is the
    /// remote size from `stat`. On cancel or error the partial local file is
    /// removed. Returns the number of bytes written. This is the production
    /// single-file download path (see [`download_to_file`]).
    pub async fn download_to_path(
        &self,
        device_id: &str,
        remote_path: &str,
        local_path: &Path,
        on_progress: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> Result<u64, AppError> {
        let conn = self.conn_of(device_id)?;
        let cancel = self.begin_transfer(device_id);
        let _guard = TransferGuard {
            manager: self,
            device_id: device_id.to_string(),
        };
        download_to_file(&conn, remote_path, local_path, &cancel, on_progress).await
    }

    /// Stream `local_path` straight to a remote file (create/truncate), chunk by
    /// chunk, never buffering the whole file. Drives `on_progress`; `total` is
    /// the local file size. On cancel or error the partial remote file is
    /// removed. Returns the number of bytes uploaded. This is the production
    /// single-file upload path (see [`upload_from_file`]).
    pub async fn upload_from_path(
        &self,
        device_id: &str,
        local_path: &Path,
        remote_path: &str,
        on_progress: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> Result<u64, AppError> {
        let conn = self.conn_of(device_id)?;
        let cancel = self.begin_transfer(device_id);
        let _guard = TransferGuard {
            manager: self,
            device_id: device_id.to_string(),
        };
        upload_from_file(
            &conn,
            local_path,
            remote_path,
            PartialUpload::Remove,
            &cancel,
            on_progress,
        )
        .await
    }

    /// Like [`upload_from_path`](Self::upload_from_path), but for writing an
    /// edited copy back over its original: the remote file is truncated in place
    /// (keeping its owner, mode and hard/symbolic links) and is **never deleted**
    /// on failure or cancel — at worst it is left incomplete until the next
    /// upload. Returns the bytes uploaded.
    pub async fn overwrite_from_path(
        &self,
        device_id: &str,
        local_path: &Path,
        remote_path: &str,
        on_progress: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> Result<u64, AppError> {
        let conn = self.conn_of(device_id)?;
        let cancel = self.begin_transfer(device_id);
        let _guard = TransferGuard {
            manager: self,
            device_id: device_id.to_string(),
        };
        upload_from_file(
            &conn,
            local_path,
            remote_path,
            PartialUpload::Keep,
            &cancel,
            on_progress,
        )
        .await
    }
}

/// The scratch path a download streams into before it is renamed onto the real
/// target — the target name with `.part` appended, so it sits in the same
/// directory (same filesystem ⇒ the finalizing rename is atomic and never
/// crosses devices).
fn partial_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

/// Stream one remote file to a local path, chunk by chunk, holding at most one
/// [`TRANSFER_CHUNK`] in memory. **The bytes land in a sibling `.part` file and
/// are renamed onto `local_path` only on full success**, so a failed or
/// cancelled download never truncates — let alone deletes — an existing target
/// (the user may have picked "overwrite" over a file they care about). On any
/// failure the scratch file is removed and the real target is untouched. Returns
/// the bytes written. Shared by the single-file download command and the
/// recursive folder download (`tree`).
pub(super) async fn download_to_file(
    conn: &Arc<SftpConn>,
    remote_path: &str,
    local_path: &Path,
    cancel: &Arc<AtomicBool>,
    on_progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<u64, AppError> {
    let tmp = partial_path(local_path);
    let outcome =
        download_into_scratch(conn, remote_path, local_path, &tmp, cancel, on_progress).await;
    if outcome.is_err() {
        // Only ever the scratch file — never the real target.
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    outcome
}

async fn download_into_scratch(
    conn: &Arc<SftpConn>,
    remote_path: &str,
    local_path: &Path,
    tmp: &Path,
    cancel: &Arc<AtomicBool>,
    on_progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<u64, AppError> {
    let disp = local_path.display().to_string();
    // Resolve size + open the remote source BEFORE creating any local file, so a
    // remote error (missing file, no permission) never touches the local side.
    let (total, mut remote) = open_download(conn, remote_path).await?;
    let mut local = tokio::fs::File::create(tmp)
        .await
        .map_err(|e| AppError::Io(format!("could not create {disp}: {e}")))?;
    let mut progress = Progress::new(cancel, on_progress, total);
    let mut chunk = vec![0u8; TRANSFER_CHUNK];
    loop {
        if progress.is_cancelled() {
            return Err(cancelled());
        }
        let n = remote
            .read(&mut chunk)
            .await
            .map_err(|e| sftp_err(&format!("could not download {remote_path}"), e))?;
        if n == 0 {
            break;
        }
        local
            .write_all(&chunk[..n])
            .await
            .map_err(|e| AppError::Io(format!("could not write {disp}: {e}")))?;
        progress.advance(n);
    }
    finish_download(local, remote, tmp, local_path).await?;
    Ok(progress.transferred)
}

/// A remote file's size (0 when the server omits it) and an open handle on it.
pub(super) async fn open_download(
    conn: &SftpConn,
    remote_path: &str,
) -> Result<(u64, File), AppError> {
    let ctx = || format!("could not download {remote_path}");
    let total = conn
        .session
        .metadata(remote_path.to_string())
        .await
        .map_err(|e| sftp_err(&ctx(), e))?
        .size
        .unwrap_or(0);
    let file = conn
        .session
        .open(remote_path.to_string())
        .await
        .map_err(|e| sftp_err(&ctx(), e))?;
    Ok((total, file))
}

/// Flush the scratch file, then atomically put the finished bytes in place
/// (replaces an existing target on both Unix and Windows — Rust's rename uses
/// REPLACE_EXISTING).
async fn finish_download(
    mut local: tokio::fs::File,
    remote: File,
    tmp: &Path,
    local_path: &Path,
) -> Result<(), AppError> {
    let disp = local_path.display().to_string();
    local
        .flush()
        .await
        .map_err(|e| AppError::Io(format!("could not write {disp}: {e}")))?;
    let _ = remote.close().await;
    tokio::fs::rename(tmp, local_path)
        .await
        .map_err(|e| AppError::Io(format!("could not finalize {disp}: {e}")))
}

/// Stream one local file to a remote path (create/truncate), chunk by chunk,
/// holding at most one [`TRANSFER_CHUNK`] in memory. With
/// [`PartialUpload::Remove`] the remote file is removed only if the transfer
/// fails **after** we created it, and only if it didn't exist before — a
/// failure reading the local source (missing/unreadable) happens first and
/// leaves any pre-existing remote file untouched. Returns the bytes uploaded. Shared by the single-file
/// upload command and the recursive folder upload (`tree`).
///
/// Unlike download, upload does not use a scratch-then-rename dance: SFTP rename
/// over an existing name is not portably an overwrite (see the Move feature's
/// collision check), so an "overwrite" upload truncates the target in place.
pub(super) async fn upload_from_file(
    conn: &Arc<SftpConn>,
    local_path: &Path,
    remote_path: &str,
    partial: PartialUpload,
    cancel: &Arc<AtomicBool>,
    on_progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<u64, AppError> {
    // Open the LOCAL source first; if this fails the remote target is untouched.
    let (total, mut local) = open_upload_source(local_path).await?;
    let partial = keep_if_existing(conn, remote_path, partial).await;
    // From here on the remote file exists (created/truncated), so a later failure
    // cleans it up.
    let mut remote = conn
        .session
        .create(remote_path.to_string())
        .await
        .map_err(|e| sftp_err(&upload_context(remote_path), e))?;
    let mut progress = Progress::new(cancel, on_progress, total);
    let outcome = stream_upload(
        &mut local,
        &mut remote,
        &mut progress,
        local_path,
        remote_path,
    )
    .await;
    finish_upload(conn, remote, remote_path, partial, outcome).await?;
    Ok(progress.transferred)
}

/// A local file's size and an open handle on it.
async fn open_upload_source(local_path: &Path) -> Result<(u64, tokio::fs::File), AppError> {
    let disp = local_path.display().to_string();
    let total = tokio::fs::metadata(local_path)
        .await
        .map_err(|e| AppError::Io(format!("could not stat {disp}: {e}")))?
        .len();
    let file = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| AppError::Io(format!("could not open {disp}: {e}")))?;
    Ok((total, file))
}

/// Copy `local` into `remote` until the end of `local`, a cancel, or an error.
async fn stream_upload(
    local: &mut tokio::fs::File,
    remote: &mut File,
    progress: &mut Progress<'_>,
    local_path: &Path,
    remote_path: &str,
) -> Result<(), AppError> {
    let mut chunk = vec![0u8; TRANSFER_CHUNK];
    loop {
        if progress.is_cancelled() {
            return Err(cancelled());
        }
        let n = local
            .read(&mut chunk)
            .await
            .map_err(|e| AppError::Io(format!("could not read {}: {e}", local_path.display())))?;
        if n == 0 {
            return Ok(());
        }
        remote
            .write_all(&chunk[..n])
            .await
            .map_err(|e| sftp_err(&upload_context(remote_path), e))?;
        progress.advance(n);
    }
}

/// Close the remote file after `outcome`; on a failure, also remove it when
/// `partial` says so.
async fn finish_upload(
    conn: &SftpConn,
    remote: File,
    remote_path: &str,
    partial: PartialUpload,
    outcome: Result<(), AppError>,
) -> Result<(), AppError> {
    let Err(err) = outcome else {
        return remote
            .close()
            .await
            .map_err(|e| sftp_err(&upload_context(remote_path), e));
    };
    let _ = remote.close().await;
    if partial == PartialUpload::Remove {
        let _ = conn.session.remove_file(remote_path.to_string()).await;
    }
    Err(err)
}

fn upload_context(remote_path: &str) -> String {
    format!("could not upload to {remote_path}")
}

/// A streaming transfer's progress: a cancel is checked before each chunk, and
/// each chunk done is reported.
pub(super) struct Progress<'a> {
    cancel: &'a AtomicBool,
    on_progress: &'a (dyn Fn(u64, u64) + Send + Sync),
    total: u64,
    transferred: u64,
}

impl<'a> Progress<'a> {
    pub(super) fn new(
        cancel: &'a AtomicBool,
        on_progress: &'a (dyn Fn(u64, u64) + Send + Sync),
        total: u64,
    ) -> Self {
        Progress {
            cancel,
            on_progress,
            total,
            transferred: 0,
        }
    }

    pub(super) fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    /// Count `bytes` more and report them; a file that grew since its size was
    /// read never shows more done than its total.
    pub(super) fn advance(&mut self, bytes: usize) {
        self.transferred += bytes as u64;
        (self.on_progress)(self.transferred, self.total.max(self.transferred));
    }
}

/// An overwrite must never end in losing the file the user chose to replace:
/// a target that already exists is kept on failure. Unsure (the stat failed)
/// counts as existing.
async fn keep_if_existing(
    conn: &Arc<SftpConn>,
    remote_path: &str,
    partial: PartialUpload,
) -> PartialUpload {
    if partial == PartialUpload::Keep {
        return partial;
    }
    match conn.session.try_exists(remote_path.to_string()).await {
        Ok(false) => PartialUpload::Remove,
        _ => PartialUpload::Keep,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn progress_reports_each_chunk_and_never_more_done_than_total() {
        let cancel = AtomicBool::new(false);
        let reports = Mutex::new(Vec::new());
        let record = |done, total| reports.lock().unwrap().push((done, total));
        let mut progress = Progress::new(&cancel, &record, 10);

        progress.advance(4);
        progress.advance(8);

        assert_eq!(progress.transferred, 12);
        assert_eq!(*reports.lock().unwrap(), [(4, 10), (12, 12)]);
    }

    #[test]
    fn progress_sees_a_cancel_requested_meanwhile() {
        let cancel = AtomicBool::new(false);
        let progress = Progress::new(&cancel, &|_, _| {}, 0);
        assert!(!progress.is_cancelled());
        cancel.store(true, Ordering::Relaxed);
        assert!(progress.is_cancelled());
    }
}
