//! Whole-file transfers in memory, chunked only on the network side. Used only
//! by the integration tests' small byte round-trips; production transfers
//! stream (see `transfer`).

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::manager::{SftpConn, SftpManager, TransferGuard};
use super::transfer::{open_download, Progress, TRANSFER_CHUNK};
use super::{cancelled, sftp_err};
use crate::error::AppError;

impl SftpManager {
    /// Download a remote file into memory (whole-file), chunking only the network
    /// read so `on_progress` can drive a bar. Production downloads stream via
    /// [`SftpManager::download_to_path`] instead.
    pub async fn read_file(
        &self,
        device_id: &str,
        path: &str,
        on_progress: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> Result<Vec<u8>, AppError> {
        let conn = self.conn_of(device_id)?;
        // Register a cancel flag; the guard removes it on every exit path.
        let cancel = self.begin_transfer(device_id);
        let _guard = TransferGuard {
            manager: self,
            device_id: device_id.to_string(),
        };
        download_bytes(&conn, path, &cancel, on_progress).await
    }

    /// Upload bytes to a remote file (create/truncate), whole-file, chunking only
    /// the network write. Production uploads stream via
    /// [`SftpManager::upload_from_path`] instead.
    pub async fn write_file(
        &self,
        device_id: &str,
        path: &str,
        data: &[u8],
        on_progress: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> Result<(), AppError> {
        let conn = self.conn_of(device_id)?;
        // Register a cancel flag; the guard removes it on every exit path.
        let cancel = self.begin_transfer(device_id);
        let _guard = TransferGuard {
            manager: self,
            device_id: device_id.to_string(),
        };
        upload_bytes(&conn, path, data, &cancel, on_progress).await
    }
}

/// Download one remote file into memory; `cancel` aborts between chunks.
async fn download_bytes(
    conn: &Arc<SftpConn>,
    path: &str,
    cancel: &Arc<AtomicBool>,
    on_progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<Vec<u8>, AppError> {
    let ctx = || format!("could not download {path}");
    let (total, mut file) = open_download(conn, path).await?;
    let mut buf = Vec::with_capacity(total as usize);
    let mut chunk = vec![0u8; TRANSFER_CHUNK];
    let mut progress = Progress::new(cancel, on_progress, total);
    loop {
        if progress.is_cancelled() {
            let _ = file.close().await;
            return Err(cancelled());
        }
        let n = file
            .read(&mut chunk)
            .await
            .map_err(|e| sftp_err(&ctx(), e))?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        progress.advance(n);
    }
    let _ = file.close().await;
    Ok(buf)
}

/// Upload bytes to one remote file (create/truncate); a cancel between chunks
/// removes the incomplete file.
async fn upload_bytes(
    conn: &Arc<SftpConn>,
    path: &str,
    data: &[u8],
    cancel: &Arc<AtomicBool>,
    on_progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<(), AppError> {
    let ctx = || format!("could not upload to {path}");
    let mut file = conn
        .session
        .create(path.to_string())
        .await
        .map_err(|e| sftp_err(&ctx(), e))?;
    let mut progress = Progress::new(cancel, on_progress, data.len() as u64);
    for piece in data.chunks(TRANSFER_CHUNK) {
        if progress.is_cancelled() {
            let _ = file.close().await;
            let _ = conn.session.remove_file(path.to_string()).await;
            return Err(cancelled());
        }
        file.write_all(piece)
            .await
            .map_err(|e| sftp_err(&ctx(), e))?;
        progress.advance(piece.len());
    }
    file.close().await.map_err(|e| sftp_err(&ctx(), e))?;
    Ok(())
}
