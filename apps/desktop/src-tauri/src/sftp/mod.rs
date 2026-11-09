//! SFTP file browsing + transfer over an SSH session (the "Files" drawer).
//!
//! The SFTP analogue of [`crate::session`] / [`crate::tunnel`]: an
//! [`SftpManager`] owns a `HashMap<device_id, SftpConn>` of live connections and
//! **reuses `ssh`'s connect + auth + host-key-TOFU path verbatim**, jump
//! host included (`establish_target`), diverging only after the handshake —
//! instead of a PTY/shell (session) or `direct-tcpip` listeners (tunnel), it opens one
//! `session` channel, requests the `sftp` subsystem, and wraps the channel
//! stream in a [`russh_sftp`] client [`SftpSession`](russh_sftp::client::SftpSession).
//!
//! Unlike a shell/tunnel — which are fire-and-forget tasks that pump until
//! stopped — SFTP is **request/response**: each browse/transfer is a Tauri
//! command that borrows the stored connection, awaits one round trip, and
//! returns. One SSH connection is kept alive per device (keyed by `device_id`)
//! so navigating directories doesn't re-authenticate each step; the underlying
//! `client::Handle` is held in `SftpConn` purely to keep that transport open
//! (dropping it disconnects). Concurrent commands on the same connection are
//! safe — `russh_sftp` serializes requests by id internally.
//!
//! **Like `session.rs`, this module is deliberately Tauri-free.** The command
//! layer supplies a [`ConnectPrompter`](crate::ssh::prompts::ConnectPrompter) that emits the shared `host_key_prompt` event;
//! everything here speaks only in [`AppError`] and plain data.
//!
//! File transfers **stream chunk-by-chunk between the remote SFTP file and a
//! local [`tokio::fs::File`]** (`download_to_file` / `upload_from_file`),
//! never holding more than one `TRANSFER_CHUNK` in memory, so an arbitrarily
//! large file transfers in constant memory. A download streams into a sibling
//! `.part` file and is renamed onto the target only on success, so a failed or
//! cancelled download never truncates or deletes an existing file; a failed
//! upload removes the remote file only if the upload itself created it. The
//! whole-file-in-memory [`SftpManager::read_file`] /
//! [`SftpManager::write_file`] helpers are retained only for the integration
//! tests' small byte round-trips.

mod file_ops;
mod listing;
mod manager;
mod names;
mod transfer;
mod tree;
mod whole_file;

use serde::Serialize;

use crate::error::AppError;
use crate::ssh::params::{AuthCredentials, JumpHop, KeepaliveConfig};

pub use manager::SftpManager;
pub(crate) use names::ensure_storable_target;

/// One directory entry returned to the frontend for the file browser. Non-secret
/// (a remote path/name and public stat fields only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    /// Base name within the listed directory (never a full path).
    pub name: String,
    /// `"dir"`, `"file"`, or `"symlink"` — what the browser renders and how a
    /// double-click behaves (descend vs. download).
    pub kind: &'static str,
    /// Size in bytes (0 when the server omits it, e.g. for a directory).
    pub size: u64,
    /// Last-modified time as a Unix timestamp (seconds), if the server reports it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified: Option<u64>,
    /// The Unix permission bits (`0o7777` mask — the rwx/setuid/sticky bits, not
    /// the file-type bits), if the server reports them. Drives the permissions
    /// column + chmod dialog; `None` when the server omits mode (rare/non-POSIX).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
}

/// A remote file's size + modification time, compared before an edit-in-place
/// upload to tell whether someone else changed the file since we fetched it.
/// `mtime` has one-second resolution (SFTP v3), so a same-size change within
/// the same second goes unnoticed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RemoteStamp {
    pub size: u64,
    pub mtime: Option<u32>,
}

/// The connection-shaped parameters for an SFTP connect, built by the
/// `sftp_connect` command from a device + its resolved credentials. Mirrors
/// `TunnelParams` (minus the forwards).
///
/// `pub` + `#[doc(hidden)]` only so the `tests/` integration tests (a separate
/// crate) can build one — see the note on `session::ConnectParams`.
#[doc(hidden)]
pub struct SftpParams {
    pub device_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub creds: AuthCredentials,
    /// SSH keepalive resolved from user settings, applied to the SFTP connection.
    pub keepalive: KeepaliveConfig,
    /// Optional jump host (`ProxyJump`): the SFTP connection to `host:port`
    /// rides a direct-tcpip channel over it. `None` ⇒ direct.
    pub jump: Option<JumpHop>,
}

/// Map any `russh_sftp` error to a secret-free [`AppError::Sftp`] with context.
/// Taken as `impl Display` so the exact error type never has to be named here.
fn sftp_err(context: &str, err: impl std::fmt::Display) -> AppError {
    AppError::Sftp(format!("{context}: {err}"))
}

/// The error a streaming transfer unwinds with when the user cancels it.
fn cancelled() -> AppError {
    AppError::Cancelled("transfer cancelled".to_string())
}
