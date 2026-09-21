//! SFTP file browsing + transfer over an SSH session (the "Files" drawer).
//!
//! The SFTP analogue of [`crate::session`] / [`crate::tunnel`]: an
//! [`SftpManager`] owns a `HashMap<device_id, SftpConn>` of live connections and
//! **reuses `session.rs`'s connect + auth + host-key-TOFU path verbatim**
//! ([`establish_with_deadline`]), diverging only after the handshake — instead
//! of a PTY/shell (session) or `direct-tcpip` listeners (tunnel), it opens one
//! `session` channel, requests the `sftp` subsystem, and wraps the channel
//! stream in a [`russh_sftp`] client [`SftpSession`].
//!
//! Unlike a shell/tunnel — which are fire-and-forget tasks that pump until
//! stopped — SFTP is **request/response**: each browse/transfer is a Tauri
//! command that borrows the stored connection, awaits one round trip, and
//! returns. One SSH connection is kept alive per device (keyed by `device_id`)
//! so navigating directories doesn't re-authenticate each step; the underlying
//! `client::Handle` is held in [`SftpConn`] purely to keep that transport open
//! (dropping it disconnects). Concurrent commands on the same connection are
//! safe — `russh_sftp` serializes requests by id internally.
//!
//! **Like `session.rs`, this module is deliberately Tauri-free.** The command
//! layer supplies an [`SftpSink`] that emits the shared `host_key_prompt` event;
//! everything here speaks only in [`AppError`] and plain data.
//!
//! File transfers **stream chunk-by-chunk between the remote SFTP file and a
//! local [`tokio::fs::File`]** ([`download_to_file`] / [`upload_from_file`]),
//! never holding more than one [`TRANSFER_CHUNK`] in memory, so an arbitrarily
//! large file transfers in constant memory. A download streams into a sibling
//! `.part` file and is renamed onto the target only on success, so a failed or
//! cancelled download never truncates or deletes an existing file; an upload
//! removes the remote file only if it fails after creating it. The
//! whole-file-in-memory [`SftpManager::read_file`] /
//! [`SftpManager::write_file`] helpers are retained only for the integration
//! tests' small byte round-trips.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Chunk size for streaming SFTP transfers (32 KiB). Only the network read/write
/// is chunked, so progress reflects the slow part; larger chunks reduce SFTP
/// round trips without materially coarsening the progress bar.
const TRANSFER_CHUNK: usize = 32 * 1024;

use crate::error::AppError;
use crate::known_hosts::KnownHostsStore;
use crate::session::{
    establish_with_deadline, AuthCredentials, HostKeyPromptPayload, KeepaliveConfig,
    PromptRegistry, SessionSink, SessionStatus, SshHandler, DEFAULT_CONNECT_TIMEOUT,
    DEFAULT_HANDSHAKE_TIMEOUT, DEFAULT_PROMPT_TIMEOUT,
};

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
}

/// Sink for the one thing the SFTP handshake surfaces to the frontend: a
/// host-key trust prompt (the same event a shell/tunnel raises, so the shared
/// dialog handles it). Object-safe for `Arc<dyn SftpSink>`.
pub trait SftpSink: Send + Sync {
    fn on_host_key_prompt(&self, payload: HostKeyPromptPayload);
}

/// Adapts an [`SftpSink`] to the [`SessionSink`] that [`SshHandler`] requires.
/// Only `on_host_key_prompt` is ever called during an SFTP handshake (there is
/// no terminal data and no session-status stream here), so the other two
/// methods are deliberate no-ops — mirrors `tunnel.rs`'s `HandshakeSink`.
struct HandshakeSink(Arc<dyn SftpSink>);

impl SessionSink for HandshakeSink {
    fn on_data(&self, _bytes: &[u8]) {}
    fn on_status(&self, _status: SessionStatus, _message: Option<String>) {}
    fn on_host_key_prompt(&self, payload: HostKeyPromptPayload) {
        self.0.on_host_key_prompt(payload);
    }
}

/// A live SFTP connection: the authenticated SSH `Handle` (kept alive only to
/// hold the transport open — dropping it disconnects) plus the `SftpSession`
/// speaking the subsystem over one channel.
struct SftpConn {
    _handle: client::Handle<SshHandler>,
    session: SftpSession,
}

/// Owns the live SFTP connections and the host-key prompt registry for SFTP
/// handshakes. Its own `PromptRegistry` (like the tunnel manager's) is resolved
/// by the `respond_host_key` command, which fans a reply out to every manager.
pub struct SftpManager {
    conns: Mutex<HashMap<String, Arc<SftpConn>>>,
    /// Cancel flags for in-flight transfers, keyed by device id. A transfer
    /// registers a fresh flag on start and removes it on end; `cancel_transfer`
    /// flips it, and the streaming loops check it each chunk. At most one
    /// transfer per device runs at a time (the frontend queue drains them
    /// sequentially), so a single flag per device is sufficient.
    transfers: Mutex<HashMap<String, Arc<AtomicBool>>>,
    prompts: Arc<PromptRegistry>,
    known_hosts: Arc<KnownHostsStore>,
    connect_timeout: Duration,
    prompt_timeout: Duration,
    handshake_timeout: Duration,
}

impl SftpManager {
    /// Construct with explicit timeouts (tests pass short ones).
    pub fn new(
        known_hosts: Arc<KnownHostsStore>,
        connect_timeout: Duration,
        prompt_timeout: Duration,
        handshake_timeout: Duration,
    ) -> Self {
        Self {
            conns: Mutex::new(HashMap::new()),
            transfers: Mutex::new(HashMap::new()),
            prompts: Arc::new(PromptRegistry::default()),
            known_hosts,
            connect_timeout,
            prompt_timeout,
            handshake_timeout,
        }
    }

    /// Production constructor with the same SPEC §6 timeouts as a shell session.
    pub fn with_defaults(known_hosts: Arc<KnownHostsStore>) -> Self {
        Self::new(
            known_hosts,
            DEFAULT_CONNECT_TIMEOUT,
            DEFAULT_PROMPT_TIMEOUT,
            DEFAULT_HANDSHAKE_TIMEOUT,
        )
    }

    /// Overall establish deadline: TCP connect + host-key prompt wait + auth,
    /// the same composition `SessionManager`/`TunnelManager` use (B3).
    fn overall_establish_timeout(&self) -> Duration {
        self.connect_timeout + self.prompt_timeout + self.handshake_timeout
    }

    fn lock_conns(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<SftpConn>>> {
        self.conns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Clone out a device's connection (lock held only for the clone, never
    /// across the subsequent `.await`), or `NotFound` if it isn't connected.
    fn conn_of(&self, device_id: &str) -> Result<Arc<SftpConn>, AppError> {
        self.lock_conns()
            .get(device_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("no SFTP connection for device {device_id}")))
    }

    /// Number of live connections (used by the app-close handler to decide
    /// whether a graceful teardown is needed).
    pub fn connection_count(&self) -> usize {
        self.lock_conns().len()
    }

    /// The device ids with a live SFTP connection, so a freshly-mounted drawer
    /// can restore its "connected" state.
    pub fn connected_devices(&self) -> Vec<String> {
        self.lock_conns().keys().cloned().collect()
    }

    /// Resolve a pending host-key trust prompt raised by an SFTP handshake.
    /// Returns whether a prompt with that id was waiting here (so the command
    /// layer knows which manager owned it).
    pub fn respond_host_key(&self, prompt_id: &str, accept: bool) -> bool {
        self.prompts.respond(prompt_id, accept)
    }

    /// Register a fresh cancel flag for a starting transfer on `device_id`,
    /// returning it for the streaming loop to poll. Replaces any stale flag.
    fn begin_transfer(&self, device_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.transfers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(device_id.to_string(), Arc::clone(&flag));
        flag
    }

    /// Remove a finished transfer's cancel flag (so a late cancel is a no-op).
    fn end_transfer(&self, device_id: &str) {
        self.transfers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(device_id);
    }

    /// Request cancellation of the in-flight transfer for `device_id` (if any):
    /// the streaming loop sees the flag on its next chunk and unwinds with
    /// `AppError::Cancelled`. Returns whether a transfer was actually in flight.
    pub fn cancel_transfer(&self, device_id: &str) -> bool {
        match self
            .transfers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(device_id)
        {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    /// Open (or replace) the SFTP connection for a device: establish + auth
    /// (racing nothing — this is awaited by the command), open the `sftp`
    /// subsystem, then store the connection. Returns the canonical starting
    /// directory (the server's default/home, from `realpath(".")`) so the
    /// browser has a path to list first. Replacing an existing connection drops
    /// the old one (closing its transport).
    pub async fn connect(
        &self,
        params: SftpParams,
        sink: Arc<dyn SftpSink>,
    ) -> Result<String, AppError> {
        let handler = SshHandler::new(
            Arc::new(HandshakeSink(sink)),
            Arc::clone(&self.known_hosts),
            Arc::clone(&self.prompts),
            params.host.clone(),
            params.port,
            self.prompt_timeout,
            params.keepalive,
            // The SFTP file browser never forwards the SSH agent.
            false,
        );

        let handle = establish_with_deadline(
            &params.host,
            params.port,
            &params.username,
            &params.creds,
            handler,
            self.connect_timeout,
            self.overall_establish_timeout(),
        )
        .await?;

        // Open one session channel and switch it to the SFTP subsystem.
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::SshChannel(format!("could not open SFTP channel: {e}")))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| AppError::Sftp(format!("server refused the SFTP subsystem: {e}")))?;
        let session = SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| sftp_err("could not start SFTP session", e))?;

        // Resolve the starting directory before storing, so a failure here
        // surfaces as a connect error rather than a half-open connection.
        let start_dir = session
            .canonicalize(".")
            .await
            .map_err(|e| sftp_err("could not resolve the home directory", e))?;

        self.lock_conns().insert(
            params.device_id,
            Arc::new(SftpConn {
                _handle: handle,
                session,
            }),
        );
        Ok(start_dir)
    }

    /// List one remote directory, directories first then files, each group sorted
    /// case-insensitively by name. `.`/`..` are never included.
    pub async fn list(&self, device_id: &str, path: &str) -> Result<Vec<SftpEntry>, AppError> {
        let conn = self.conn_of(device_id)?;
        let read_dir = conn
            .session
            .read_dir(path.to_string())
            .await
            .map_err(|e| sftp_err(&format!("could not list {path}"), e))?;

        let mut entries: Vec<SftpEntry> = read_dir
            .filter(|e| {
                let name = e.file_name();
                name != "." && name != ".."
            })
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
        upload_from_file(&conn, local_path, remote_path, &cancel, on_progress).await
    }

    /// Download a remote file into memory (whole-file), chunking only the network
    /// read so `on_progress` can drive a bar. Retained for the integration tests'
    /// small byte round-trips; production downloads stream via
    /// [`download_to_path`] instead.
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
    /// the network write. Retained for the integration tests' small byte
    /// round-trips; production uploads stream via [`upload_from_path`] instead.
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

    /// Recursively download a remote directory tree into `local_dir` (which the
    /// caller has already created/renamed per the chosen conflict policy). With
    /// `skip_existing`, local files that already exist are left untouched (a
    /// merge); otherwise they are overwritten. One cancel flag covers the whole
    /// walk. Symlinked directories are not descended (a symlink is treated as a
    /// file), mirroring `remove_recursive`.
    pub async fn download_dir(
        &self,
        device_id: &str,
        remote_dir: &str,
        local_dir: &Path,
        skip_existing: bool,
        on_progress: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> Result<(), AppError> {
        let conn = self.conn_of(device_id)?;
        let cancel = self.begin_transfer(device_id);
        let _guard = TransferGuard {
            manager: self,
            device_id: device_id.to_string(),
        };
        download_tree(
            &conn,
            remote_dir,
            local_dir,
            skip_existing,
            &cancel,
            on_progress,
        )
        .await
    }

    /// Recursively upload a local directory tree into `remote_dir` (already
    /// created/renamed by the caller per policy). With `skip_existing`, remote
    /// files that already exist are left untouched; otherwise overwritten. Local
    /// symlinks are skipped. One cancel flag covers the whole walk.
    pub async fn upload_dir(
        &self,
        device_id: &str,
        local_dir: &Path,
        remote_dir: &str,
        skip_existing: bool,
        on_progress: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> Result<(), AppError> {
        let conn = self.conn_of(device_id)?;
        let cancel = self.begin_transfer(device_id);
        let _guard = TransferGuard {
            manager: self,
            device_id: device_id.to_string(),
        };
        upload_tree(
            &conn,
            local_dir,
            remote_dir,
            skip_existing,
            &cancel,
            on_progress,
        )
        .await
    }

    /// Whether a remote path exists — used by the command layer to detect a
    /// conflict before a transfer and to resolve a rename target.
    pub async fn remote_exists(&self, device_id: &str, path: &str) -> Result<bool, AppError> {
        let conn = self.conn_of(device_id)?;
        Ok(conn.session.metadata(path.to_string()).await.is_ok())
    }

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

    /// Close and forget a device's SFTP connection. Idempotent: an unknown
    /// device is a no-op. Best-effort `close()`; the transport is torn down when
    /// the `Arc<SftpConn>` (and thus the `Handle`) is dropped regardless.
    pub async fn disconnect(&self, device_id: &str) {
        let conn = self.lock_conns().remove(device_id);
        if let Some(conn) = conn {
            let _ = conn.session.close().await;
        }
    }

    /// Close every connection (app-close cleanup). Drains the map first so the
    /// lock is never held across an `.await`.
    pub async fn disconnect_all(&self) {
        let conns: Vec<Arc<SftpConn>> = self.lock_conns().drain().map(|(_, c)| c).collect();
        for conn in conns {
            let _ = conn.session.close().await;
        }
    }
}

/// Join a POSIX parent path and a child name for remote paths (root stays a
/// single leading slash, never `//child`).
fn join_remote(parent: &str, name: &str) -> String {
    format!("{}/{}", parent.trim_end_matches('/'), name)
}

/// Whether a server-supplied directory-entry name is a single, ordinary path
/// component that is safe to join onto a local path. Rejects empty, `.`, `..`,
/// any name containing a path separator (`/`, or `\` on Windows), and absolute,
/// rooted, drive- or UNC-prefixed names. This closes a path-traversal hole: a
/// hostile or compromised SFTP server could otherwise return an entry named e.g.
/// `../../.bashrc` or an absolute path and steer a folder download's local write
/// **outside** the directory the user chose. Evaluated with the *local* OS's
/// path rules, since that is where the bytes are written.
fn is_safe_name(name: &str) -> bool {
    use std::path::Component;
    let mut components = Path::new(name).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(c)), None) => c == std::ffi::OsStr::new(name),
        _ => false,
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

/// Download one remote file into memory, chunked so `on_progress` can drive a
/// bar and the shared `cancel` flag can abort between chunks. Factored out of
/// [`SftpManager::read_file`] so the recursive [`download_tree`] can reuse it
/// under a single per-operation cancel flag.
async fn download_bytes(
    conn: &Arc<SftpConn>,
    path: &str,
    cancel: &Arc<AtomicBool>,
    on_progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<Vec<u8>, AppError> {
    let ctx = || format!("could not download {path}");
    let total = conn
        .session
        .metadata(path.to_string())
        .await
        .map_err(|e| sftp_err(&ctx(), e))?
        .size
        .unwrap_or(0);
    let mut file = conn
        .session
        .open(path.to_string())
        .await
        .map_err(|e| sftp_err(&ctx(), e))?;
    let mut buf = Vec::with_capacity(total as usize);
    let mut chunk = vec![0u8; TRANSFER_CHUNK];
    let mut transferred: u64 = 0;
    loop {
        if cancel.load(Ordering::Relaxed) {
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
        transferred += n as u64;
        on_progress(transferred, total.max(transferred));
    }
    let _ = file.close().await;
    Ok(buf)
}

/// Upload bytes to one remote file (create/truncate), chunked with cancel
/// support. Factored out of [`SftpManager::write_file`] for [`upload_tree`].
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
    let total = data.len() as u64;
    let mut transferred: u64 = 0;
    for piece in data.chunks(TRANSFER_CHUNK) {
        if cancel.load(Ordering::Relaxed) {
            let _ = file.close().await;
            let _ = conn.session.remove_file(path.to_string()).await;
            return Err(cancelled());
        }
        file.write_all(piece)
            .await
            .map_err(|e| sftp_err(&ctx(), e))?;
        transferred += piece.len() as u64;
        on_progress(transferred, total);
    }
    file.close().await.map_err(|e| sftp_err(&ctx(), e))?;
    Ok(())
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
/// recursive [`download_tree`].
async fn download_to_file(
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
    let ctx = || format!("could not download {remote_path}");
    let disp = local_path.display().to_string();
    // Resolve size + open the remote source BEFORE creating any local file, so a
    // remote error (missing file, no permission) never touches the local side.
    let total = conn
        .session
        .metadata(remote_path.to_string())
        .await
        .map_err(|e| sftp_err(&ctx(), e))?
        .size
        .unwrap_or(0);
    let mut remote = conn
        .session
        .open(remote_path.to_string())
        .await
        .map_err(|e| sftp_err(&ctx(), e))?;
    let mut local = tokio::fs::File::create(tmp)
        .await
        .map_err(|e| AppError::Io(format!("could not create {disp}: {e}")))?;
    let mut chunk = vec![0u8; TRANSFER_CHUNK];
    let mut transferred: u64 = 0;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        let n = remote
            .read(&mut chunk)
            .await
            .map_err(|e| sftp_err(&ctx(), e))?;
        if n == 0 {
            break;
        }
        local
            .write_all(&chunk[..n])
            .await
            .map_err(|e| AppError::Io(format!("could not write {disp}: {e}")))?;
        transferred += n as u64;
        on_progress(transferred, total.max(transferred));
    }
    local
        .flush()
        .await
        .map_err(|e| AppError::Io(format!("could not write {disp}: {e}")))?;
    let _ = remote.close().await;
    // Atomically put the finished bytes in place (replaces an existing target on
    // both Unix and Windows — Rust's rename uses REPLACE_EXISTING).
    tokio::fs::rename(tmp, local_path)
        .await
        .map_err(|e| AppError::Io(format!("could not finalize {disp}: {e}")))?;
    Ok(transferred)
}

/// Stream one local file to a remote path (create/truncate), chunk by chunk,
/// holding at most one [`TRANSFER_CHUNK`] in memory. The remote file is removed
/// only if the transfer fails **after** we created it — a failure reading the
/// local source (missing/unreadable) happens first and leaves any pre-existing
/// remote file untouched. Returns the bytes uploaded. Shared by the single-file
/// upload command and the recursive [`upload_tree`].
///
/// Unlike download, upload does not use a scratch-then-rename dance: SFTP rename
/// over an existing name is not portably an overwrite (see the Move feature's
/// collision check), so an "overwrite" upload truncates the target in place.
async fn upload_from_file(
    conn: &Arc<SftpConn>,
    local_path: &Path,
    remote_path: &str,
    cancel: &Arc<AtomicBool>,
    on_progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<u64, AppError> {
    let ctx = || format!("could not upload to {remote_path}");
    let disp = local_path.display().to_string();
    // Open the LOCAL source first; if this fails the remote target is untouched.
    let total = tokio::fs::metadata(local_path)
        .await
        .map_err(|e| AppError::Io(format!("could not stat {disp}: {e}")))?
        .len();
    let mut local = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| AppError::Io(format!("could not open {disp}: {e}")))?;
    // From here on the remote file exists (created/truncated), so a later failure
    // cleans it up.
    let mut remote = conn
        .session
        .create(remote_path.to_string())
        .await
        .map_err(|e| sftp_err(&ctx(), e))?;

    let mut chunk = vec![0u8; TRANSFER_CHUNK];
    let mut transferred: u64 = 0;
    let outcome: Result<(), AppError> = loop {
        if cancel.load(Ordering::Relaxed) {
            break Err(cancelled());
        }
        let n = match local.read(&mut chunk).await {
            Ok(0) => break Ok(()),
            Ok(n) => n,
            Err(e) => break Err(AppError::Io(format!("could not read {disp}: {e}"))),
        };
        if let Err(e) = remote.write_all(&chunk[..n]).await {
            break Err(sftp_err(&ctx(), e));
        }
        transferred += n as u64;
        on_progress(transferred, total.max(transferred));
    };

    match outcome {
        Ok(()) => {
            remote.close().await.map_err(|e| sftp_err(&ctx(), e))?;
            Ok(transferred)
        }
        Err(e) => {
            let _ = remote.close().await;
            let _ = conn.session.remove_file(remote_path.to_string()).await;
            Err(e)
        }
    }
}

/// Recursively download `remote_dir` into `local_dir`, boxed so the `async fn`
/// can recurse. Creates each local directory, then downloads files (skipping
/// existing ones when `skip_existing`). Checks `cancel` before each entry.
fn download_tree<'a>(
    conn: &'a Arc<SftpConn>,
    remote_dir: &'a str,
    local_dir: &'a Path,
    skip_existing: bool,
    cancel: &'a Arc<AtomicBool>,
    on_progress: &'a (dyn Fn(u64, u64) + Send + Sync),
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), AppError>> + Send + 'a>> {
    Box::pin(async move {
        // Ensure the target directory exists (blocking FS off the async runtime).
        let make = local_dir.to_path_buf();
        let disp = local_dir.display().to_string();
        tokio::task::spawn_blocking(move || std::fs::create_dir_all(&make))
            .await
            .map_err(|e| AppError::Io(format!("mkdir task failed: {e}")))?
            .map_err(|e| AppError::Io(format!("could not create {disp}: {e}")))?;

        let read_dir = conn
            .session
            .read_dir(remote_dir.to_string())
            .await
            .map_err(|e| sftp_err(&format!("could not list {remote_dir}"), e))?;
        for entry in read_dir {
            if cancel.load(Ordering::Relaxed) {
                return Err(cancelled());
            }
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            // Never let a server-chosen name escape the destination directory (a
            // traversal like `../../x` or an absolute path). Fail closed.
            if !is_safe_name(&name) {
                return Err(AppError::Sftp(format!(
                    "server returned an unsafe entry name {name:?} while downloading {remote_dir}"
                )));
            }
            let remote_child = join_remote(remote_dir, &name);
            let local_child = local_dir.join(&name);
            if entry.file_type().is_dir() {
                download_tree(
                    conn,
                    &remote_child,
                    &local_child,
                    skip_existing,
                    cancel,
                    on_progress,
                )
                .await?;
            } else {
                if skip_existing {
                    let probe = local_child.clone();
                    let exists = tokio::task::spawn_blocking(move || probe.exists())
                        .await
                        .map_err(|e| AppError::Io(format!("stat task failed: {e}")))?;
                    if exists {
                        continue;
                    }
                }
                // Stream straight to disk — no whole-file buffer per entry.
                download_to_file(conn, &remote_child, &local_child, cancel, on_progress).await?;
            }
        }
        Ok(())
    })
}

/// One local entry discovered while walking a directory to upload — a POSIX-style
/// path relative to the upload root, with parents ordered before their children.
struct LocalWalkEntry {
    rel: String,
    is_dir: bool,
}

/// Walk a local directory top-down (parents before children), collecting
/// directories and regular files (symlinks are skipped so the upload can't
/// follow a link out of the tree or into a cycle).
fn walk_local(root: &Path) -> std::io::Result<Vec<LocalWalkEntry>> {
    fn rec(dir: &Path, prefix: &str, out: &mut Vec<LocalWalkEntry>) -> std::io::Result<()> {
        let mut names: Vec<_> = std::fs::read_dir(dir)?.collect::<Result<_, _>>()?;
        names.sort_by_key(|e| e.file_name());
        for e in names {
            let file_type = e.file_type()?;
            let name = e.file_name().to_string_lossy().into_owned();
            let rel = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            if file_type.is_dir() {
                out.push(LocalWalkEntry {
                    rel: rel.clone(),
                    is_dir: true,
                });
                rec(&e.path(), &rel, out)?;
            } else if file_type.is_file() {
                out.push(LocalWalkEntry { rel, is_dir: false });
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    rec(root, "", &mut out)?;
    Ok(out)
}

/// Recursively upload `local_dir` into `remote_dir`: create each remote
/// subdirectory (ignoring an already-exists error), then upload files (skipping
/// existing ones when `skip_existing`). Checks `cancel` before each entry.
async fn upload_tree(
    conn: &Arc<SftpConn>,
    local_dir: &Path,
    remote_dir: &str,
    skip_existing: bool,
    cancel: &Arc<AtomicBool>,
    on_progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<(), AppError> {
    let root = local_dir.to_path_buf();
    let disp = local_dir.display().to_string();
    let entries = tokio::task::spawn_blocking(move || walk_local(&root))
        .await
        .map_err(|e| AppError::Io(format!("upload walk task failed: {e}")))?
        .map_err(|e| AppError::Io(format!("could not read {disp}: {e}")))?;

    for entry in entries {
        if cancel.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        let remote_child = join_remote(remote_dir, &entry.rel);
        if entry.is_dir {
            // Create the remote subdirectory; an already-exists error is benign
            // (a real failure surfaces when a file upload into it fails).
            let _ = conn.session.create_dir(remote_child).await;
        } else {
            if skip_existing && conn.session.metadata(remote_child.clone()).await.is_ok() {
                continue;
            }
            let local_file = local_dir.join(&entry.rel);
            // Stream straight from disk — no whole-file buffer per entry.
            upload_from_file(conn, &local_file, &remote_child, cancel, on_progress).await?;
        }
    }
    Ok(())
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

/// Removes a transfer's cancel flag on drop, so it is cleared no matter how the
/// streaming loop exits (completion, error, or an early cancel return).
struct TransferGuard<'a> {
    manager: &'a SftpManager,
    device_id: String,
}

impl Drop for TransferGuard<'_> {
    fn drop(&mut self) {
        self.manager.end_transfer(&self.device_id);
    }
}

#[cfg(test)]
mod tests {
    use super::{is_safe_name, join_remote};

    #[test]
    fn join_remote_keeps_a_single_root_slash() {
        assert_eq!(join_remote("/", "child"), "/child");
        assert_eq!(join_remote("/a", "b"), "/a/b");
        assert_eq!(join_remote("/a/", "b"), "/a/b");
    }

    #[test]
    fn is_safe_name_accepts_ordinary_names() {
        for name in ["file.txt", "a folder", "weird-name_1", ".hidden", "résumé"] {
            assert!(is_safe_name(name), "{name:?} should be safe");
        }
    }

    #[test]
    fn is_safe_name_rejects_traversal_and_rooted_names() {
        // Empty, dot segments, and anything with a POSIX separator.
        for name in [
            "",
            ".",
            "..",
            "a/b",
            "../evil",
            "/etc/passwd",
            "a/../b",
            "/",
        ] {
            assert!(!is_safe_name(name), "{name:?} must be rejected");
        }
    }

    #[cfg(windows)]
    #[test]
    fn is_safe_name_rejects_windows_separators_and_prefixes() {
        // On Windows, `\` is a separator and drive/UNC prefixes must be rejected.
        for name in [
            r"a\b",
            r"..\evil",
            r"C:\Windows\x",
            r"\\host\share\x",
            r"C:x",
        ] {
            assert!(!is_safe_name(name), "{name:?} must be rejected on Windows");
        }
    }
}
