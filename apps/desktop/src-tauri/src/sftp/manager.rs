//! The live SFTP connections, one per device: connect, disconnect, prompts,
//! and the cancel flag of each device's running transfer.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use russh::client;
use russh_sftp::client::SftpSession;
use tokio::task::JoinSet;
use tokio::time::timeout;

use super::{sftp_err, SftpParams};
use crate::error::AppError;
use crate::ssh::connector::{SshConnection, SshConnector};
use crate::ssh::handler::SshHandler;
use crate::ssh::prompts::ConnectPrompter;

/// A live SFTP connection: the SSH connection (kept alive only to hold the
/// transport open — dropping it disconnects), plus the `SftpSession` speaking
/// the subsystem over one channel.
pub(super) struct SftpConn {
    connection: SshConnection,
    pub(super) session: SftpSession,
}

/// Owns the live SFTP connections.
pub struct SftpManager {
    conns: Mutex<HashMap<String, Arc<SftpConn>>>,
    /// Cancel flags for in-flight transfers, keyed by device id. A transfer
    /// registers a fresh flag on start and removes it on end; `cancel_transfer`
    /// flips it, and the streaming loops check it each chunk. At most one
    /// transfer per device runs at a time (the frontend queue drains them
    /// sequentially), so a single flag per device is sufficient.
    transfers: Mutex<HashMap<String, Arc<AtomicBool>>>,
    ssh: Arc<SshConnector>,
}

impl SftpManager {
    pub fn new(ssh: Arc<SshConnector>) -> Self {
        Self {
            conns: Mutex::new(HashMap::new()),
            transfers: Mutex::new(HashMap::new()),
            ssh,
        }
    }

    fn lock_conns(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<SftpConn>>> {
        self.conns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Clone out a device's connection (lock held only for the clone, never
    /// across the subsequent `.await`), or `NotFound` if it isn't connected.
    pub(super) fn conn_of(&self, device_id: &str) -> Result<Arc<SftpConn>, AppError> {
        self.lock_conns()
            .get(device_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("no SFTP connection for device {device_id}")))
    }

    /// Whether `device_id` has a connection (live or not yet noticed dead).
    pub fn is_connected(&self, device_id: &str) -> bool {
        self.lock_conns().contains_key(device_id)
    }

    /// Number of live connections (used by the app-close handler to decide
    /// whether a graceful teardown is needed).
    pub fn connection_count(&self) -> usize {
        self.lock_conns().len()
    }

    /// The device ids with a live SFTP connection, so a freshly-mounted drawer
    /// can restore its "connected" state. A connection whose transport already
    /// ended (the server closed it, the network dropped) is not live.
    pub fn connected_devices(&self) -> Vec<String> {
        self.lock_conns()
            .iter()
            .filter(|(_, conn)| !conn.connection.handle().is_closed())
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Register a fresh cancel flag for a starting transfer on `device_id`,
    /// returning it for the streaming loop to poll. Replaces any stale flag.
    pub(super) fn begin_transfer(&self, device_id: &str) -> Arc<AtomicBool> {
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
        prompter: Arc<dyn ConnectPrompter>,
    ) -> Result<String, AppError> {
        let handler = self.handler_for(&params, prompter);
        let connection = self
            .ssh
            .connect(
                params.target.endpoint(),
                params.target.jump.as_ref(),
                handler,
            )
            .await?;
        let opened = self.open_sftp_or_close_connection(&connection, &params);
        let (session, start_dir) = opened.await?;
        let conn = SftpConn {
            connection,
            session,
        };
        self.lock_conns().insert(params.device_id, Arc::new(conn));
        Ok(start_dir)
    }

    /// Open SFTP at the home directory within the handshake budget (the
    /// establish deadline is spent, and its clock is internal to it); closes
    /// the connection when that fails.
    async fn open_sftp_or_close_connection(
        &self,
        connection: &SshConnection,
        params: &SftpParams,
    ) -> Result<(SftpSession, String), AppError> {
        let budget = self.ssh.timeouts().handshake;
        let opened = timeout(budget, open_at_home(connection.handle()))
            .await
            .unwrap_or_else(|_| Err(open_timed_out(params)));
        if opened.is_err() {
            connection.close().await;
        }
        opened
    }

    fn handler_for(&self, params: &SftpParams, prompter: Arc<dyn ConnectPrompter>) -> SshHandler {
        // The SFTP file browser never forwards the SSH agent.
        let target = &params.target;
        self.ssh
            .handler(target.host.clone(), target.port, target.keepalive, prompter)
            .with_purpose("SFTP")
    }

    /// Close and forget a device's SFTP connection. Idempotent: an unknown
    /// device is a no-op. Best-effort: closes the SFTP channel, then ends the
    /// SSH session explicitly (like shells and tunnels) rather than waiting for
    /// the last `Arc<SftpConn>` clone to drop.
    pub async fn disconnect(&self, device_id: &str) {
        let conn = self.lock_conns().remove(device_id);
        if let Some(conn) = conn {
            close_conn(&conn).await;
        }
    }

    /// Close every connection (app-close cleanup), side by side so stuck
    /// servers hold up quit for one close, not one each. Drains the map first
    /// so the lock is never held across an `.await`.
    pub async fn disconnect_all(&self) {
        let conns: Vec<Arc<SftpConn>> = self.lock_conns().drain().map(|(_, c)| c).collect();
        let mut closing = JoinSet::new();
        for conn in conns {
            closing.spawn(async move { close_conn(&conn).await });
        }
        closing.join_all().await;
    }
}

/// Open SFTP and resolve the starting directory, so a failure surfaces as a
/// connect error rather than a half-open connection.
async fn open_at_home(
    handle: &client::Handle<SshHandler>,
) -> Result<(SftpSession, String), AppError> {
    let session = open_sftp_session(handle).await?;
    let start_dir = session
        .canonicalize(".")
        .await
        .map_err(|e| sftp_err("could not resolve the home directory", e))?;
    Ok((session, start_dir))
}

fn open_timed_out(params: &SftpParams) -> AppError {
    AppError::SshConnect(format!(
        "connecting to {}:{} timed out while opening SFTP",
        params.target.host, params.target.port
    ))
}

/// Open one session channel and switch it to the SFTP subsystem.
async fn open_sftp_session(handle: &client::Handle<SshHandler>) -> Result<SftpSession, AppError> {
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::SshChannel(format!("could not open SFTP channel: {e}")))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| AppError::Sftp(format!("server refused the SFTP subsystem: {e}")))?;
    SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| sftp_err("could not start SFTP session", e))
}

async fn close_conn(conn: &SftpConn) {
    let _ = conn.session.close().await;
    conn.connection.close().await;
}

/// Removes a transfer's cancel flag on drop, so it is cleared no matter how the
/// streaming loop exits (completion, error, or an early cancel return).
pub(super) struct TransferGuard<'a> {
    pub(super) manager: &'a SftpManager,
    pub(super) device_id: String,
}

impl Drop for TransferGuard<'_> {
    fn drop(&mut self) {
        self.manager.end_transfer(&self.device_id);
    }
}
