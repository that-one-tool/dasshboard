//! The live SFTP connections, one per device: connect, disconnect, prompts,
//! and the cancel flag of each device's running transfer.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client;
use russh_sftp::client::SftpSession;

use super::{sftp_err, SftpParams};
use crate::error::AppError;
use crate::known_hosts::KnownHostsStore;
use crate::ssh::establish::{
    close_jump, establish_target, overall_establish_timeout, JumpConnection,
    DEFAULT_CONNECT_TIMEOUT, DEFAULT_HANDSHAKE_TIMEOUT, DEFAULT_PROMPT_TIMEOUT,
};
use crate::ssh::handler::SshHandler;
use crate::ssh::params::Endpoint;
use crate::ssh::prompts::{AuthAnswers, ConnectPrompter, ConnectPrompts};

/// A live SFTP connection: the authenticated SSH `Handle` (kept alive only to
/// hold the transport open — dropping it disconnects), the jump host's handle
/// the transport rides on (for a jumped connection; same reason), plus the
/// `SftpSession` speaking the subsystem over one channel.
pub(super) struct SftpConn {
    pub(super) handle: client::Handle<SshHandler>,
    jump: Option<JumpConnection>,
    pub(super) session: SftpSession,
}

/// Owns the live SFTP connections and the host-key prompt registry for SFTP
/// handshakes. Its own `ConnectPrompts` (like the tunnel manager's) is resolved
/// by the `respond_host_key` command, which fans a reply out to every manager.
pub struct SftpManager {
    conns: Mutex<HashMap<String, Arc<SftpConn>>>,
    /// Cancel flags for in-flight transfers, keyed by device id. A transfer
    /// registers a fresh flag on start and removes it on end; `cancel_transfer`
    /// flips it, and the streaming loops check it each chunk. At most one
    /// transfer per device runs at a time (the frontend queue drains them
    /// sequentially), so a single flag per device is sufficient.
    transfers: Mutex<HashMap<String, Arc<AtomicBool>>>,
    prompts: Arc<ConnectPrompts>,
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
            prompts: Arc::new(ConnectPrompts::default()),
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

    fn overall_establish_timeout(&self) -> Duration {
        overall_establish_timeout(
            self.connect_timeout,
            self.prompt_timeout,
            self.handshake_timeout,
        )
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
            .filter(|(_, conn)| !conn.handle.is_closed())
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Resolve a pending host-key trust prompt raised by an SFTP handshake.
    /// Returns whether a prompt with that id was waiting here (so the command
    /// layer knows which manager owned it).
    pub fn respond_host_key(&self, prompt_id: &str, accept: bool) -> bool {
        self.prompts.respond_host_key(prompt_id, accept)
    }

    /// Resolve a pending keyboard-interactive prompt; `false` if it isn't ours.
    pub fn respond_auth(&self, prompt_id: &str, answers: AuthAnswers) -> bool {
        self.prompts.respond_auth(prompt_id, answers)
    }

    /// The dialog shows an auth prompt; `false` if it isn't ours.
    pub fn mark_auth_shown(&self, prompt_id: &str) -> bool {
        self.prompts.mark_auth_shown(prompt_id)
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
        let target = Endpoint {
            host: &params.host,
            port: params.port,
            username: &params.username,
            creds: &params.creds,
        };
        let (handle, jump) = establish_target(
            target,
            params.jump.as_ref(),
            handler,
            self.connect_timeout,
            self.overall_establish_timeout(),
        )
        .await?;
        let session = open_sftp_session(&handle).await?;

        // Resolve the starting directory before storing, so a failure here
        // surfaces as a connect error rather than a half-open connection.
        let start_dir = session
            .canonicalize(".")
            .await
            .map_err(|e| sftp_err("could not resolve the home directory", e))?;

        self.lock_conns().insert(
            params.device_id,
            Arc::new(SftpConn {
                handle,
                jump,
                session,
            }),
        );
        Ok(start_dir)
    }

    fn handler_for(&self, params: &SftpParams, prompter: Arc<dyn ConnectPrompter>) -> SshHandler {
        // The SFTP file browser never forwards the SSH agent.
        SshHandler::new(
            prompter,
            Arc::clone(&self.known_hosts),
            Arc::clone(&self.prompts),
            params.host.clone(),
            params.port,
            self.prompt_timeout,
            params.keepalive,
        )
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

    /// Close every connection (app-close cleanup). Drains the map first so the
    /// lock is never held across an `.await`.
    pub async fn disconnect_all(&self) {
        let conns: Vec<Arc<SftpConn>> = self.lock_conns().drain().map(|(_, c)| c).collect();
        for conn in conns {
            close_conn(&conn).await;
        }
    }
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
    let _ = conn
        .handle
        .disconnect(russh::Disconnect::ByApplication, "", "")
        .await;
    close_jump(conn.jump.as_ref()).await;
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
