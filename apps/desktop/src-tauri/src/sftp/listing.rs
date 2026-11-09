//! Browsing: list a directory, resolve a path, stat a file.

use super::manager::SftpManager;
use super::names::is_listable_name;
use super::{sftp_err, RemoteStamp, SftpEntry};
use crate::error::AppError;

impl SftpManager {
    /// List one remote directory, directories first then files, each group sorted
    /// case-insensitively by name. `.`/`..` and impossible names are never
    /// included (see [`is_listable_name`]).
    pub async fn list(&self, device_id: &str, path: &str) -> Result<Vec<SftpEntry>, AppError> {
        let conn = self.conn_of(device_id)?;
        let read_dir = conn
            .session
            .read_dir(path.to_string())
            .await
            .map_err(|e| sftp_err(&format!("could not list {path}"), e))?;

        let mut entries: Vec<SftpEntry> = read_dir
            .filter(|e| is_listable_name(&e.file_name()))
            .map(|e| {
                let file_type = e.file_type();
                let kind = if file_type.is_dir() {
                    "dir"
                } else if file_type.is_symlink() {
                    "symlink"
                } else {
                    "file"
                };
                let metadata = e.metadata();
                SftpEntry {
                    name: e.file_name(),
                    kind,
                    size: metadata.size.unwrap_or(0),
                    modified: metadata.mtime.map(u64::from),
                    // Keep only the permission bits (drop the file-type bits).
                    mode: metadata.permissions.map(|p| p & 0o7777),
                }
            })
            .collect();

        entries.sort_by(|a, b| {
            let a_dir = a.kind == "dir";
            let b_dir = b.kind == "dir";
            b_dir
                .cmp(&a_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    }

    /// Resolve a path to its canonical absolute form (used for robust `..`
    /// navigation and to expand a `~`-free relative path).
    pub async fn canonicalize(&self, device_id: &str, path: &str) -> Result<String, AppError> {
        let conn = self.conn_of(device_id)?;
        conn.session
            .canonicalize(path.to_string())
            .await
            .map_err(|e| sftp_err(&format!("could not resolve {path}"), e))
    }

    /// The size of the file `path` points to (following symlinks), refusing a
    /// directory: what the Files panel checks before opening it for editing.
    pub async fn editable_size(&self, device_id: &str, path: &str) -> Result<u64, AppError> {
        let conn = self.conn_of(device_id)?;
        let metadata = conn
            .session
            .metadata(path.to_string())
            .await
            .map_err(|e| sftp_err(&format!("could not stat {path}"), e))?;
        if metadata.is_dir() {
            return Err(AppError::Validation(format!("{path} is a folder")));
        }
        Ok(metadata.size.unwrap_or(0))
    }

    /// The remote file's current size + mtime (following symlinks).
    pub async fn remote_stamp(&self, device_id: &str, path: &str) -> Result<RemoteStamp, AppError> {
        let conn = self.conn_of(device_id)?;
        let metadata = conn
            .session
            .metadata(path.to_string())
            .await
            .map_err(|e| sftp_err(&format!("could not stat {path}"), e))?;
        Ok(RemoteStamp {
            size: metadata.size.unwrap_or(0),
            mtime: metadata.mtime,
        })
    }

    /// Whether a remote path exists — used by the command layer to detect a
    /// conflict before a transfer and to resolve a rename target.
    pub async fn remote_exists(&self, device_id: &str, path: &str) -> Result<bool, AppError> {
        let conn = self.conn_of(device_id)?;
        Ok(conn.session.metadata(path.to_string()).await.is_ok())
    }
}
