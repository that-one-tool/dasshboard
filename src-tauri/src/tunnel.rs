//! SSH local port-forwarding (`ssh -L`) — the tunnel analogue of `session.rs`
//! (SPEC tunnels §2). A [`TunnelManager`] owns a `HashMap<TunnelId, TunnelHandle>`,
//! one `tokio` task per live tunnel, and reuses `session.rs`'s connect + auth +
//! host-key-TOFU path verbatim ([`establish_with_deadline`]). It diverges only
//! *after* authentication: instead of requesting a PTY + shell, it binds a local
//! `TcpListener` for each configured forward and pumps every accepted connection
//! over a `direct-tcpip` channel to `remoteHost:remotePort` (resolved from the
//! SSH server).
//!
//! **Like `session.rs`, this module is deliberately Tauri-free.** All
//! frontend-facing effects go through the [`TunnelSink`] trait, whose production
//! implementor lives in `commands.rs` (emitting `tunnel_status` events) and whose
//! test implementor records into channels.
//!
//! ## Concurrency & cleanup (mirrors `session.rs`)
//!
//! - One tunnel = **one SSH connection** carrying **one local listener per
//!   forward** (`ssh -L a -L b host`). The `client::Handle` is shared into each
//!   listener via an `Arc` (it is not `Clone`), which is enough because every
//!   method the listeners call — `channel_open_direct_tcpip`, `send_keepalive`,
//!   `disconnect` — takes `&self`.
//! - Listener tasks live in the tunnel task's [`JoinSet`]; each listener owns a
//!   nested `JoinSet` of per-connection copy tasks. Dropping a `JoinSet` aborts
//!   its tasks, so a `listeners.shutdown()` on stop cascades: listeners abort →
//!   their per-connection `JoinSet`s drop → in-flight copies abort. No handle is
//!   held across teardown that could leak a socket.
//! - Each tunnel task removes its own map entry on **every** terminal reason
//!   (auth failure, all binds failing, stop, transport drop). Cleanup has a
//!   single owner, exactly as `SessionManager` does.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client;
use serde::Serialize;
use tokio::io::copy_bidirectional;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio::time::MissedTickBehavior;

use crate::device::Forward;
use crate::error::AppError;
use crate::known_hosts::KnownHostsStore;
use crate::session::{
    establish_with_deadline, AuthCredentials, HostKeyPromptPayload, PromptRegistry, SessionSink,
    SessionStatus, SshHandler, DEFAULT_CONNECT_TIMEOUT, DEFAULT_HANDSHAKE_TIMEOUT,
    DEFAULT_PROMPT_TIMEOUT,
};

/// Keepalive cadence for an otherwise-idle tunnel — same as a shell session, to
/// keep NAT/firewall state alive and notice a dead transport promptly.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);

/// Control-channel bound. A tunnel's control channel only ever carries a single
/// `Stop`; the bound just keeps it from being unbounded (a standing review
/// concern), mirroring `session.rs`.
const CONTROL_CHANNEL_CAPACITY: usize = 8;

/// Lifecycle status mirrored to the frontend `tunnel_status` event. Distinct
/// from [`SessionStatus`] because a tunnel is `Listening` (bound, awaiting
/// connections) rather than `Connected`, and has no terminal-data phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TunnelStatus {
    Connecting,
    Listening,
    Disconnected,
    Error,
}

impl TunnelStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TunnelStatus::Connecting => "connecting",
            TunnelStatus::Listening => "listening",
            TunnelStatus::Disconnected => "disconnected",
            TunnelStatus::Error => "error",
        }
    }
}

/// Per-forward bind outcome carried in a `Listening` status. Non-secret.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardStatus {
    pub forward_id: String,
    pub local_addr: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    /// Whether the local listener bound successfully. A `false` here means this
    /// one forward's local port was unavailable; the rest of the tunnel still
    /// runs (SPEC tunnels §2).
    pub bound: bool,
}

/// A live tunnel as reported by `list_tunnels`. Non-secret.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInfo {
    pub tunnel_id: String,
    pub device_id: String,
}

/// Sink for everything the tunnel core surfaces to the frontend. The production
/// impl emits `tunnel_status` events; the test impl records into channels. Kept
/// object-safe (`Arc<dyn TunnelSink>`).
pub trait TunnelSink: Send + Sync {
    /// A lifecycle change → `tunnel_status` event. `forwards` carries per-forward
    /// bind state on a `Listening` status and is empty otherwise.
    fn on_status(
        &self,
        status: TunnelStatus,
        message: Option<String>,
        forwards: Vec<ForwardStatus>,
    );
    /// An unknown/changed host key needs the user's decision → `host_key_prompt`
    /// event (the same event a shell session raises; the dialog is shared).
    fn on_host_key_prompt(&self, payload: HostKeyPromptPayload);
}

/// Adapts a [`TunnelSink`] to the [`SessionSink`] that [`SshHandler`] requires
/// for the handshake. Only `on_host_key_prompt` is ever called by the handler
/// (terminal I/O and lifecycle for a tunnel are handled outside the handler), so
/// the other two methods are inert.
struct HandshakeSink(Arc<dyn TunnelSink>);

impl SessionSink for HandshakeSink {
    fn on_data(&self, _bytes: &[u8]) {}
    fn on_status(&self, _status: SessionStatus, _message: Option<String>) {}
    fn on_host_key_prompt(&self, payload: HostKeyPromptPayload) {
        self.0.on_host_key_prompt(payload);
    }
}

/// The connection-shaped parameters for a tunnel, constructed by the
/// `start_tunnel` command in `commands.rs` (hence `pub(crate)`).
pub(crate) struct TunnelParams {
    pub(crate) device_id: String,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) creds: AuthCredentials,
    /// The forwards to bind. Non-empty (the command rejects a device with none).
    pub(crate) forwards: Vec<Forward>,
}

/// Control messages sent to a tunnel task via its mpsc handle. Currently just a
/// graceful stop; kept as an enum so more controls can be added without changing
/// the channel type.
enum TunnelControl {
    Stop,
}

/// The manager's per-tunnel handle: the control `Sender` plus the owning device
/// id (so `list_tunnels` can report which device each live tunnel belongs to).
/// Dropping every clone of the sender makes the task's `control_rx.recv()`
/// return `None`, which the task treats as a stop.
struct TunnelHandle {
    control: mpsc::Sender<TunnelControl>,
    device_id: String,
}

/// Owns all live tunnels. Lives in Tauri managed state behind an `Arc` (see
/// `AppState`). Shares the host-key TOFU store with `SessionManager` so a trust
/// decision made for a shell applies to a tunnel to the same host and vice
/// versa; its own `PromptRegistry` is resolved by the `respond_host_key` command
/// fanning a response out to both managers.
pub struct TunnelManager {
    tunnels: Mutex<HashMap<String, TunnelHandle>>,
    prompts: Arc<PromptRegistry>,
    known_hosts: Arc<KnownHostsStore>,
    connect_timeout: Duration,
    prompt_timeout: Duration,
    handshake_timeout: Duration,
}

impl TunnelManager {
    pub fn new(
        known_hosts: Arc<KnownHostsStore>,
        connect_timeout: Duration,
        prompt_timeout: Duration,
        handshake_timeout: Duration,
    ) -> Self {
        TunnelManager {
            tunnels: Mutex::new(HashMap::new()),
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

    /// Overall deadline for the establish flow — TCP connect + handshake + any
    /// host-key prompt wait + auth (B3). Same composition as `SessionManager`.
    fn overall_establish_timeout(&self) -> Duration {
        self.connect_timeout + self.prompt_timeout + self.handshake_timeout
    }

    /// Number of live tunnels currently tracked. Used by the app-close handler
    /// (`lib.rs`) and by leak-check tests.
    pub fn tunnel_count(&self) -> usize {
        self.lock_tunnels().len()
    }

    /// Snapshot of the live tunnels for `list_tunnels`.
    pub fn list(&self) -> Vec<TunnelInfo> {
        self.lock_tunnels()
            .iter()
            .map(|(tunnel_id, handle)| TunnelInfo {
                tunnel_id: tunnel_id.clone(),
                device_id: handle.device_id.clone(),
            })
            .collect()
    }

    fn lock_tunnels(&self) -> std::sync::MutexGuard<'_, HashMap<String, TunnelHandle>> {
        self.tunnels
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Clone out a tunnel's control `Sender` (lock held only for the clone,
    /// never across the subsequent await).
    fn control_of(&self, tunnel_id: &str) -> Option<mpsc::Sender<TunnelControl>> {
        self.lock_tunnels()
            .get(tunnel_id)
            .map(|h| h.control.clone())
    }

    /// Resolve a pending host-key trust prompt raised by a tunnel. Returns
    /// whether a prompt with that id was actually waiting here, so the command
    /// layer can fan the response out to both managers and know which owned it.
    pub fn respond_host_key(&self, prompt_id: &str, accept: bool) -> bool {
        self.prompts.respond(prompt_id, accept)
    }

    /// Spawn a live tunnel. Inserts the handle synchronously (so the map reflects
    /// the tunnel the instant this returns) and drives the rest on a tokio task
    /// that removes its own entry on exit.
    pub fn spawn_tunnel(
        self: &Arc<Self>,
        tunnel_id: String,
        params: TunnelParams,
        sink: Arc<dyn TunnelSink>,
    ) {
        let (control_tx, control_rx) = mpsc::channel(CONTROL_CHANNEL_CAPACITY);
        self.lock_tunnels().insert(
            tunnel_id.clone(),
            TunnelHandle {
                control: control_tx,
                device_id: params.device_id.clone(),
            },
        );

        let handler = SshHandler::new(
            Arc::new(HandshakeSink(Arc::clone(&sink))),
            Arc::clone(&self.known_hosts),
            Arc::clone(&self.prompts),
            params.host.clone(),
            params.port,
            self.prompt_timeout,
        );
        let manager = Arc::clone(self);
        let connect_timeout = self.connect_timeout;
        let overall_timeout = self.overall_establish_timeout();

        tokio::spawn(async move {
            sink.on_status(TunnelStatus::Connecting, None, Vec::new());

            let result = run_tunnel(
                params,
                handler,
                connect_timeout,
                overall_timeout,
                Arc::clone(&sink),
                control_rx,
            )
            .await;

            match result {
                Ok(()) => sink.on_status(TunnelStatus::Disconnected, None, Vec::new()),
                // AppError messages are always secret-free (see error.rs).
                Err(err) => sink.on_status(TunnelStatus::Error, Some(err.to_string()), Vec::new()),
            }

            manager.lock_tunnels().remove(&tunnel_id);
        });
    }

    /// Request a graceful stop. Idempotent: an unknown `tunnel_id` is a no-op.
    /// The task performs the actual map removal when it exits.
    pub async fn stop_tunnel(&self, tunnel_id: &str) {
        if let Some(control) = self.control_of(tunnel_id) {
            let _ = control.send(TunnelControl::Stop).await;
        }
    }

    /// Stop *every* live tunnel and wait (briefly) for their tasks to release
    /// their listeners, so closing the app frees the bound local ports cleanly.
    /// Bounded by a short timeout so a stuck tunnel can never block the quit.
    pub async fn stop_all(&self) {
        let ids: Vec<String> = self.lock_tunnels().keys().cloned().collect();
        for id in &ids {
            self.stop_tunnel(id).await;
        }
        for _ in 0..50 {
            if self.tunnel_count() == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

/// The full lifecycle of one tunnel task: connect+auth (racing an early stop),
/// bind the forwards, then serve until stopped or the transport drops. Returns
/// `Ok(())` for any clean end and `Err` for a failure that should surface as
/// `tunnel_status: error`.
async fn run_tunnel(
    params: TunnelParams,
    handler: SshHandler,
    connect_timeout: Duration,
    overall_timeout: Duration,
    sink: Arc<dyn TunnelSink>,
    mut control_rx: mpsc::Receiver<TunnelControl>,
) -> Result<(), AppError> {
    let handle = tokio::select! {
        biased;
        // A stop during the handshake aborts: dropping the `establish` future
        // drops the handler (and any PromptGuard within), cleaning up a pending
        // host-key prompt too.
        _ = wait_for_stop(&mut control_rx) => return Ok(()),
        result = establish_with_deadline(
            &params.host,
            params.port,
            &params.username,
            &params.creds,
            handler,
            connect_timeout,
            overall_timeout,
        ) => result?,
    };

    let handle = Arc::new(handle);

    // Bind a listener per forward; a failure on one is non-fatal to the others.
    let mut listeners = JoinSet::new();
    let statuses = bind_forwards(&params.forwards, &handle, &mut listeners).await;

    if listeners.is_empty() {
        return Err(AppError::TunnelBind(
            "none of the tunnel's local ports could be bound".to_string(),
        ));
    }

    sink.on_status(TunnelStatus::Listening, None, statuses);

    serve_until_stopped(&handle, &mut control_rx).await;

    // Abort every listener (which cascades to their in-flight connection tasks),
    // then close the SSH transport cleanly.
    listeners.shutdown().await;
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "", "")
        .await;
    Ok(())
}

/// Bind a local `TcpListener` for each forward and spawn its accept loop into
/// `listeners`. Returns a per-forward [`ForwardStatus`] (bound or not) for the
/// `Listening` event. A bind failure is recorded (`bound: false`) but does not
/// abort the others.
async fn bind_forwards(
    forwards: &[Forward],
    handle: &Arc<client::Handle<SshHandler>>,
    listeners: &mut JoinSet<()>,
) -> Vec<ForwardStatus> {
    let mut statuses = Vec::with_capacity(forwards.len());
    for forward in forwards {
        let bound = match TcpListener::bind((forward.local_addr.as_str(), forward.local_port)).await
        {
            Ok(listener) => {
                listeners.spawn(run_listener(
                    listener,
                    Arc::clone(handle),
                    forward.remote_host.clone(),
                    forward.remote_port,
                ));
                true
            }
            Err(_) => false,
        };
        statuses.push(ForwardStatus {
            forward_id: forward.id.clone(),
            local_addr: forward.local_addr.clone(),
            local_port: forward.local_port,
            remote_host: forward.remote_host.clone(),
            remote_port: forward.remote_port,
            bound,
        });
    }
    statuses
}

/// Accept loop for one forward: every accepted local connection opens a
/// `direct-tcpip` channel and is copied bidirectionally. Per-connection tasks
/// live in a local `JoinSet` that is reaped as connections finish (bounding
/// memory) and dropped — aborting any in-flight copies — when this loop ends
/// (i.e. when the listener is aborted on tunnel stop).
async fn run_listener(
    listener: TcpListener,
    handle: Arc<client::Handle<SshHandler>>,
    remote_host: String,
    remote_port: u16,
) {
    let mut conns = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((tcp, peer)) => {
                    conns.spawn(handle_connection(
                        tcp,
                        Arc::clone(&handle),
                        remote_host.clone(),
                        remote_port,
                        peer,
                    ));
                }
                // The listening socket died; nothing more to accept.
                Err(_) => break,
            },
            // Reap finished connection tasks so the set doesn't grow unbounded
            // over a long-lived tunnel serving many short connections.
            _ = conns.join_next(), if !conns.is_empty() => {}
        }
    }
}

/// Copy one accepted local connection to a fresh `direct-tcpip` channel and
/// back until either side closes. A channel-open failure just drops the local
/// connection (the DB client sees a closed socket); it never affects the tunnel.
async fn handle_connection(
    mut tcp: TcpStream,
    handle: Arc<client::Handle<SshHandler>>,
    remote_host: String,
    remote_port: u16,
    peer: SocketAddr,
) {
    let channel = match handle
        .channel_open_direct_tcpip(
            remote_host,
            u32::from(remote_port),
            peer.ip().to_string(),
            u32::from(peer.port()),
        )
        .await
    {
        Ok(channel) => channel,
        Err(_) => return,
    };
    let mut stream = channel.into_stream();
    let _ = copy_bidirectional(&mut tcp, &mut stream).await;
}

/// Serve the tunnel until a stop is requested or the transport dies: drive
/// keepalives and wait for a control message. Returns when the loop should end.
async fn serve_until_stopped(
    handle: &Arc<client::Handle<SshHandler>>,
    control_rx: &mut mpsc::Receiver<TunnelControl>,
) {
    let mut keepalive = tokio::time::interval(KEEPALIVE_INTERVAL);
    keepalive.set_missed_tick_behavior(MissedTickBehavior::Delay);
    keepalive.tick().await; // consume the immediate first tick

    loop {
        let keep_running = tokio::select! {
            _ = keepalive.tick() => handle.send_keepalive(false).await.is_ok(),
            // Any control message (currently only `Stop`) or a dropped handle
            // (`None`) ends the tunnel.
            _ = control_rx.recv() => false,
        };
        if !keep_running {
            break;
        }
    }
}

/// Wait for a stop request (or the manager dropping the handle). Used to race
/// the handshake so a stop requested mid-handshake tears the task down promptly.
async fn wait_for_stop(rx: &mut mpsc::Receiver<TunnelControl>) {
    let _ = rx.recv().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tunnel_status_serializes_to_expected_strings() {
        assert_eq!(TunnelStatus::Connecting.as_str(), "connecting");
        assert_eq!(TunnelStatus::Listening.as_str(), "listening");
        assert_eq!(TunnelStatus::Disconnected.as_str(), "disconnected");
        assert_eq!(TunnelStatus::Error.as_str(), "error");
    }

    #[test]
    fn forward_status_is_camel_case() {
        let value = serde_json::to_value(ForwardStatus {
            forward_id: "f1".into(),
            local_addr: "127.0.0.1".into(),
            local_port: 5432,
            remote_host: "db".into(),
            remote_port: 5432,
            bound: true,
        })
        .unwrap();
        assert_eq!(value["forwardId"], "f1");
        assert_eq!(value["localAddr"], "127.0.0.1");
        assert_eq!(value["localPort"], 5432);
        assert_eq!(value["remoteHost"], "db");
        assert_eq!(value["remotePort"], 5432);
        assert_eq!(value["bound"], true);
    }

    #[test]
    fn tunnel_info_is_camel_case() {
        let value = serde_json::to_value(TunnelInfo {
            tunnel_id: "t1".into(),
            device_id: "d1".into(),
        })
        .unwrap();
        assert_eq!(value["tunnelId"], "t1");
        assert_eq!(value["deviceId"], "d1");
    }
}
