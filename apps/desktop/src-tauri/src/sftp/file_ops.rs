//! Changes to remote entries: chmod, mkdir, rename, delete.

use std::sync::Arc;

use super::manager::{SftpConn, SftpManager};
use super::names::join_remote;
use super::sftp_err;
use crate::error::AppError;

impl SftpManager {
    /// Change a remote entry's Unix permission bits (chmod). Only the low
    /// `0o7777` bits (rwx + setuid/setgid/sticky) are sent; the server keeps the
    /// entry's file-type bits. A no-op-shaped `SETSTAT` on a server without POSIX
    /// permissions surfaces as an [`AppError::Sftp`].
    pub async fn chmod(&self, device_id: &str, path: &str, mode: u32) -> Result<(), AppError> {
        let conn = self.conn_of(device_id)?;
        let attrs = russh_sftp::protocol::FileAttributes {
            permissions: Some(mode & 0o7777),
            ..Default::default()
        };
        conn.session
            .set_metadata(path.to_string(), attrs)
            .await
            .map_err(|e| sftp_err(&format!("could not change permissions of {path}"), e))
    }

    /// Create a remote directory.
    pub async fn mkdir(&self, device_id: &str, path: &str) -> Result<(), AppError> {
        let conn = self.conn_of(device_id)?;
        conn.session
            .create_dir(path.to_string())
            .await
            .map_err(|e| sftp_err(&format!("could not create {path}"), e))
    }

    /// Rename/move a remote entry.
    pub async fn rename(&self, device_id: &str, from: &str, to: &str) -> Result<(), AppError> {
        let conn = self.conn_of(device_id)?;
        conn.session
            .rename(from.to_string(), to.to_string())
            .await
            .map_err(|e| sftp_err(&format!("could not rename {from}"), e))
    }

    /// Remove a remote file.
    pub async fn remove_file(&self, device_id: &str, path: &str) -> Result<(), AppError> {
        let conn = self.conn_of(device_id)?;
        conn.session
            .remove_file(path.to_string())
            .await
            .map_err(|e| sftp_err(&format!("could not delete {path}"), e))
    }

    /// Remove a remote directory (must be empty — see [`remove_recursive`] for a
    /// non-empty tree).
    pub async fn remove_dir(&self, device_id: &str, path: &str) -> Result<(), AppError> {
        let conn = self.conn_of(device_id)?;
        conn.session
            .remove_dir(path.to_string())
            .await
            .map_err(|e| sftp_err(&format!("could not remove directory {path}"), e))
    }

    /// Recursively delete a directory and everything under it (depth-first:
    /// children first, then the directory). Symlinks are removed as links (never
    /// followed), so a symlinked directory's target is left untouched. Used by
    /// bulk delete so a non-empty folder can be removed in one action.
    pub async fn remove_recursive(&self, device_id: &str, path: &str) -> Result<(), AppError> {
        let conn = self.conn_of(device_id)?;
        remove_tree(&conn, path).await
    }
}

/// Depth-first recursive delete of a directory tree, boxed so the `async fn` can
/// recurse. Deletes every child (recursing into real subdirectories, removing
/// files and symlinks directly) before removing the now-empty directory itself.
fn remove_tree<'a>(
    conn: &'a Arc<SftpConn>,
    path: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), AppError>> + Send + 'a>> {
    Box::pin(async move {
        let read_dir = conn
            .session
            .read_dir(path.to_string())
            .await
            .map_err(|e| sftp_err(&format!("could not list {path}"), e))?;
        for entry in read_dir {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let child = join_remote(path, &name);
            if entry.file_type().is_dir() {
                remove_tree(conn, &child).await?;
            } else {
                conn.session
                    .remove_file(child.clone())
                    .await
                    .map_err(|e| sftp_err(&format!("could not delete {child}"), e))?;
            }
        }
        conn.session
            .remove_dir(path.to_string())
            .await
            .map_err(|e| sftp_err(&format!("could not remove directory {path}"), e))
    })
}
