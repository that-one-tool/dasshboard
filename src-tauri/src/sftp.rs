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
//! Transfers read/write whole files in memory (`read`/`write`), which is simple
//! and correct for the config files, logs and archives this drawer is for; very
//! large files are not streamed in v1.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client;
use russh_sftp::client::SftpSession;
use serde::Serialize;

use crate::error::AppError;
use crate::known_hosts::KnownHostsStore;
use crate::session::{
    establish_with_deadline, AuthCredentials, HostKeyPromptPayload, PromptRegistry, SessionSink,
    SessionStatus, SshHandler, DEFAULT_CONNECT_TIMEOUT, DEFAULT_HANDSHAKE_TIMEOUT,
    DEFAULT_PROMPT_TIMEOUT,
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
}

/// The connection-shaped parameters for an SFTP connect, built by the
/// `sftp_connect` command from a device + its resolved credentials. Mirrors
/// `TunnelParams` (minus the forwards).
pub(crate) struct SftpParams {
    pub(crate) device_id: String,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) creds: AuthCredentials,
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

    /// Read a whole remote file into memory (the download source; the command
    /// writes the bytes to the user-chosen local path).
    pub async fn read_file(&self, device_id: &str, path: &str) -> Result<Vec<u8>, AppError> {
        let conn = self.conn_of(device_id)?;
        conn.session
            .read(path.to_string())
            .await
            .map_err(|e| sftp_err(&format!("could not download {path}"), e))
    }

    /// Write bytes to a remote file (create/truncate), the upload sink; the
    /// command supplies the bytes read from the user-chosen local file.
    pub async fn write_file(
        &self,
        device_id: &str,
        path: &str,
        data: &[u8],
    ) -> Result<(), AppError> {
        let conn = self.conn_of(device_id)?;
        conn.session
            .write(path.to_string(), data)
            .await
            .map_err(|e| sftp_err(&format!("could not upload to {path}"), e))
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

    /// Remove a remote directory (must be empty — the frontend does not recurse).
    pub async fn remove_dir(&self, device_id: &str, path: &str) -> Result<(), AppError> {
        let conn = self.conn_of(device_id)?;
        conn.session
            .remove_dir(path.to_string())
            .await
            .map_err(|e| sftp_err(&format!("could not remove directory {path}"), e))
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

/// Map any `russh_sftp` error to a secret-free [`AppError::Sftp`] with context.
/// Taken as `impl Display` so the exact error type never has to be named here.
fn sftp_err(context: &str, err: impl std::fmt::Display) -> AppError {
    AppError::Sftp(format!("{context}: {err}"))
}
