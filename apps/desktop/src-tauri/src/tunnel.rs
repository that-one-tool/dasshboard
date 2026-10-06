//! SSH port-forwarding (`ssh -L` / `ssh -D` / `ssh -R`) — the tunnel analogue of `session.rs`
//! (SPEC tunnels §2). A [`TunnelManager`] owns a `HashMap<TunnelId, TunnelHandle>`,
//! one `tokio` task per live tunnel, and reuses `session.rs`'s connect + auth +
//! host-key-TOFU path verbatim, jump host included ([`establish_target`]). It
//! diverges only *after* authentication: instead of requesting a PTY + shell,
//! it binds a local `TcpListener` for each configured forward and pumps every
//! accepted connection
//! over a `direct-tcpip` channel to `remoteHost:remotePort` (resolved from the
//! SSH server) — or, for a dynamic forward (`ssh -D`), to whatever target the
//! connection's SOCKS request names (see `socks.rs`). A remote forward
//! (`ssh -R`) binds nothing here: it asks the server to listen, and the
//! connections the server sends back are dialed to its local target (see
//! `remote_forward.rs`).
//!
//! **Like `session.rs`, this module is deliberately Tauri-free.** All
//! frontend-facing effects go through the [`TunnelSink`] trait, whose production
//! implementor lives in `commands.rs` (emitting `tunnel_status` events) and whose
//! test implementor records into channels.
//!
//! ## Concurrency & cleanup (mirrors `session.rs`)
//!
//! - One tunnel = **one SSH connection** carrying **one local listener per
//!   forward** (`ssh -L a -L b host`). Forwards can be added to and removed from
//!   a live tunnel one at a time over its control channel; releasing the last
//!   bound one ends the tunnel. The `client::Handle` is shared into each
//!   listener via an `Arc` (it is not `Clone`), which is enough because every
//!   method the listeners call — `channel_open_direct_tcpip`, `send_keepalive`,
//!   `disconnect` — takes `&self`.
//! - Each listener task is owned by its [`ActiveForwards`] entry and owns a
//!   nested `JoinSet` of per-connection copy tasks. Removing a forward (or
//!   stopping the tunnel) aborts and awaits its listener, which cascades: the
//!   per-connection `JoinSet` drops → in-flight copies abort. No handle is held
//!   across teardown that could leak a socket.
//! - Each tunnel task removes its own map entry on **every** terminal reason
//!   (auth failure, all binds failing, stop, transport drop). Cleanup has a
//!   single owner, exactly as `SessionManager` does.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::{client, Channel, ChannelOpenFailure};
use serde::Serialize;
use tokio::io::{copy_bidirectional, AsyncRead, AsyncWrite};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::MissedTickBehavior;

use crate::device::{Forward, ForwardKind};
use crate::error::AppError;
use crate::known_hosts::KnownHostsStore;
use crate::remote_forward::RemoteRoutes;
use crate::session::{
    close_jump, establish_target, AuthCredentials, Endpoint, HostKeyPromptPayload, JumpHop,
    KeepaliveConfig, PromptRegistry, SessionSink, SessionStatus, SshHandler,
    DEFAULT_CONNECT_TIMEOUT, DEFAULT_HANDSHAKE_TIMEOUT, DEFAULT_PROMPT_TIMEOUT,
};
use crate::socks;

/// Control-channel bound. A tunnel's control channel carries the occasional
/// user-driven forward add/remove and a final `Stop`; the bound just keeps it
/// from being unbounded (a standing review concern), mirroring `session.rs`.
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
    /// The forwards it serves or, while still connecting, will bind.
    pub forward_ids: Vec<String>,
    /// Per-forward bind state as last reported on `Listening` (empty while it
    /// is still connecting).
    pub forwards: Vec<ForwardStatus>,
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
    /// The prompt can no longer be answered → `host_key_prompt_closed` event.
    fn on_host_key_prompt_closed(&self, _prompt_id: &str) {}
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
    fn on_host_key_prompt_closed(&self, prompt_id: &str) {
        self.0.on_host_key_prompt_closed(prompt_id);
    }
}

/// The connection-shaped parameters for a tunnel, constructed by the
/// `start_tunnel` command in `commands.rs`.
///
/// `pub` + `#[doc(hidden)]` only so the `tests/` integration tests (a separate
/// crate) can build one — see the note on `session::ConnectParams`.
#[doc(hidden)]
pub struct TunnelParams {
    pub device_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub creds: AuthCredentials,
    /// The forwards to bind. Non-empty (the command rejects a device with none).
    pub forwards: Vec<Forward>,
    /// SSH keepalive resolved from user settings, applied to the tunnel's
    /// connection (same semantics as a shell session).
    pub keepalive: KeepaliveConfig,
    /// Optional jump host (`ProxyJump`): the tunnel's connection to `host:port`
    /// rides a direct-tcpip channel over it. `None` ⇒ direct.
    pub jump: Option<JumpHop>,
}

/// Control messages sent to a tunnel task via its mpsc handle.
enum TunnelControl {
    /// End the tunnel gracefully.
    Stop,
    /// Bind one more forward on the live connection (re-binding it if it is
    /// already there, e.g. to retry a port that was in use).
    AddForward(Forward),
    /// Release one forward's listener, by forward id.
    RemoveForward(String),
}

/// What `list_tunnels` reports about a tunnel's forwards: the ids it serves (or
/// will bind, while connecting) and their last-reported bind state.
#[derive(Default)]
struct TunnelSnapshot {
    forward_ids: Vec<String>,
    forwards: Vec<ForwardStatus>,
}

/// Shared between a tunnel's task (writer) and the manager's `list` (reader).
type ForwardSnapshot = Arc<Mutex<TunnelSnapshot>>;

/// The manager's per-tunnel handle: the control `Sender`, the owning device id
/// and the last-reported forwards (so `list_tunnels` can describe each live
/// tunnel). Dropping every clone of the sender makes the task's
/// `control_rx.recv()` return `None`, which the task treats as a stop.
struct TunnelHandle {
    control: mpsc::Sender<TunnelControl>,
    device_id: String,
    forwards: ForwardSnapshot,
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
            .map(|(tunnel_id, handle)| {
                let snapshot = lock_snapshot(&handle.forwards);
                TunnelInfo {
                    tunnel_id: tunnel_id.clone(),
                    device_id: handle.device_id.clone(),
                    forward_ids: snapshot.forward_ids.clone(),
                    forwards: snapshot.forwards.clone(),
                }
            })
            .collect()
    }

    /// The device a live tunnel belongs to, or `None` for an unknown id.
    pub fn device_of(&self, tunnel_id: &str) -> Option<String> {
        self.lock_tunnels()
            .get(tunnel_id)
            .map(|h| h.device_id.clone())
    }

    /// Whether a live tunnel has this id.
    pub fn owns(&self, tunnel_id: &str) -> bool {
        self.lock_tunnels().contains_key(tunnel_id)
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
        let snapshot = ForwardSnapshot::default();
        lock_snapshot(&snapshot).forward_ids = forward_ids(&params.forwards);
        self.lock_tunnels().insert(
            tunnel_id.clone(),
            TunnelHandle {
                control: control_tx,
                device_id: params.device_id.clone(),
                forwards: Arc::clone(&snapshot),
            },
        );

        let routes = Arc::new(RemoteRoutes::default());
        let handler = SshHandler::new(
            Arc::new(HandshakeSink(Arc::clone(&sink))),
            Arc::clone(&self.known_hosts),
            Arc::clone(&self.prompts),
            params.host.clone(),
            params.port,
            self.prompt_timeout,
            params.keepalive,
            // Tunnels never forward the SSH agent.
            false,
        )
        .with_remote_routes(Arc::clone(&routes));
        let manager = Arc::clone(self);
        let connect_timeout = self.connect_timeout;
        let overall_timeout = self.overall_establish_timeout();

        tokio::spawn(async move {
            sink.on_status(TunnelStatus::Connecting, None, Vec::new());

            let publisher = Publisher {
                sink: Arc::clone(&sink),
                snapshot,
            };
            let result = run_tunnel(
                params,
                handler,
                routes,
                connect_timeout,
                overall_timeout,
                publisher,
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
        self.send(tunnel_id, TunnelControl::Stop).await;
    }

    /// Bind `forward` on a live tunnel's connection; a new `Listening` status
    /// reports the result. `false` when no live tunnel has this id.
    pub async fn add_forward(&self, tunnel_id: &str, forward: Forward) -> bool {
        self.send(tunnel_id, TunnelControl::AddForward(forward))
            .await
    }

    /// Release one forward of a live tunnel; releasing its last bound forward
    /// ends the tunnel. Idempotent: unknown ids are a no-op.
    pub async fn remove_forward(&self, tunnel_id: &str, forward_id: String) {
        self.send(tunnel_id, TunnelControl::RemoveForward(forward_id))
            .await;
    }

    /// Deliver a control message; `false` when the tunnel is gone.
    async fn send(&self, tunnel_id: &str, control: TunnelControl) -> bool {
        match self.control_of(tunnel_id) {
            Some(sender) => sender.send(control).await.is_ok(),
            None => false,
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

/// Reports a tunnel's `Listening` forward set to the frontend and keeps the
/// manager's snapshot of it (for `list_tunnels`) in step.
struct Publisher {
    sink: Arc<dyn TunnelSink>,
    snapshot: ForwardSnapshot,
}

impl Publisher {
    /// Record the forwards a still-connecting tunnel will bind (not reported to
    /// the frontend, which asked for them).
    fn pending(&self, forwards: &[Forward]) {
        lock_snapshot(&self.snapshot).forward_ids = forward_ids(forwards);
    }

    fn listening(&self, forwards: Vec<ForwardStatus>) {
        *lock_snapshot(&self.snapshot) = TunnelSnapshot {
            forward_ids: forwards.iter().map(|f| f.forward_id.clone()).collect(),
            forwards: forwards.clone(),
        };
        self.sink.on_status(TunnelStatus::Listening, None, forwards);
    }
}

fn forward_ids(forwards: &[Forward]) -> Vec<String> {
    forwards.iter().map(|f| f.id.clone()).collect()
}

fn lock_snapshot(snapshot: &ForwardSnapshot) -> std::sync::MutexGuard<'_, TunnelSnapshot> {
    snapshot
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The full lifecycle of one tunnel task: connect+auth (racing an early stop,
/// and queuing forward changes made meanwhile), bind the forwards, then serve
/// until stopped, the last bound forward is released, or the transport drops.
/// Returns `Ok(())` for any clean end and `Err` for a failure that should
/// surface as `tunnel_status: error`.
async fn run_tunnel(
    params: TunnelParams,
    mut handler: SshHandler,
    routes: Arc<RemoteRoutes>,
    connect_timeout: Duration,
    overall_timeout: Duration,
    publisher: Publisher,
    mut control_rx: mpsc::Receiver<TunnelControl>,
) -> Result<(), AppError> {
    let TunnelParams {
        host,
        port,
        username,
        creds,
        mut forwards,
        keepalive,
        jump,
        ..
    } = params;
    // Abandons a pending host-key prompt if this returns mid-handshake.
    let _owner = handler.take_owner_token();
    let target = Endpoint {
        host: &host,
        port,
        username: &username,
        creds: &creds,
    };
    // `jump_handle` (for a jumped tunnel) must outlive the forwards: the
    // tunnel's connection rides a channel over it.
    let (handle, jump_handle) = tokio::select! {
        biased;
        // A stop (or every forward released) during the handshake aborts:
        // dropping the `establish` future drops the handler (and any
        // PromptGuard within), cleaning up a pending host-key prompt too.
        _ = queue_until_stop(&mut control_rx, &mut forwards, &publisher) => return Ok(()),
        result = establish_target(
            target,
            jump.as_ref(),
            handler,
            connect_timeout,
            overall_timeout,
        ) => result?,
    };

    let handle = Arc::new(handle);

    // Bind each forward; a failure on one is non-fatal to the others.
    let mut active = ActiveForwards::new(Arc::clone(&handle), routes);
    for forward in &forwards {
        active.add(forward).await;
    }

    if !active.any_bound() {
        return Err(AppError::TunnelBind(
            "none of the tunnel's forwards could be started".to_string(),
        ));
    }

    publisher.listening(active.statuses());

    let end =
        serve_until_stopped(&handle, &mut control_rx, keepalive, &mut active, &publisher).await;

    // Abort every listener (which cascades to their in-flight connection tasks),
    // then close the SSH transport cleanly.
    active.clear().await;
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "", "")
        .await;
    close_jump(jump_handle.as_ref()).await;
    match end {
        ServeEnd::Stopped => Ok(()),
        ServeEnd::ConnectionLost => Err(AppError::SshConnect(
            "the SSH connection was lost".to_string(),
        )),
    }
}

/// Apply forward changes requested while the tunnel is still connecting to the
/// set it will bind; returns on a stop, a dropped handle, or once no forward is
/// left to bind.
async fn queue_until_stop(
    rx: &mut mpsc::Receiver<TunnelControl>,
    pending: &mut Vec<Forward>,
    publisher: &Publisher,
) {
    while let Some(control) = rx.recv().await {
        if !queue(pending, control) {
            return;
        }
        publisher.pending(pending);
    }
}

/// Apply one control to the not-yet-bound forward set; `false` means the
/// tunnel should not go ahead (stopped, or nothing left to bind).
fn queue(pending: &mut Vec<Forward>, control: TunnelControl) -> bool {
    match control {
        TunnelControl::Stop => return false,
        TunnelControl::AddForward(forward) => {
            pending.retain(|f| f.id != forward.id);
            pending.push(forward);
        }
        TunnelControl::RemoveForward(id) => pending.retain(|f| f.id != id),
    }
    !pending.is_empty()
}

/// Why `serve_until_stopped` returned.
enum ServeEnd {
    /// A stop was requested, the manager dropped the handle, or the last bound
    /// forward was released.
    Stopped,
    /// The SSH transport went away under the tunnel.
    ConnectionLost,
}

/// How often the serve loop checks whether russh has seen the transport end.
const TRANSPORT_CHECK_INTERVAL: Duration = Duration::from_secs(1);

/// Pause before accepting again after a failed `accept` (e.g. out of file
/// descriptors), so a transient failure doesn't end the forward or spin.
const ACCEPT_RETRY_DELAY: Duration = Duration::from_millis(250);

/// How long the server gets to answer a remote forward's listen (or cancel)
/// request before the forward is reported unbound.
const SERVER_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// What keeps a started forward serving. Each kind cleans up when dropped, so
/// a forward dropped without `release` (e.g. its tunnel task aborted, or a
/// refused request) never leaves a port bound or connections routed.
enum Binding {
    /// `-L` / `-D`: the accept loop on the local port.
    Listener(LocalListener),
    /// `-R`: the server listens; its connections are routed here.
    Server(ServerListen),
}

/// A local forward's accept-loop task. A dropped `JoinHandle` detaches rather
/// than aborts, hence the `Drop`.
struct LocalListener(JoinHandle<()>);

impl LocalListener {
    /// Abort the accept loop and wait for it to drop its socket, so the port is
    /// free again by the time the change is reported.
    async fn stop(mut self) {
        self.0.abort();
        let _ = (&mut self.0).await;
    }
}

impl Drop for LocalListener {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// A remote forward's listen on the server, on `address:port`, and its route
/// (owned by forward `owner`), released when this is dropped.
struct ServerListen {
    address: String,
    port: u16,
    owner: String,
    routes: Arc<RemoteRoutes>,
}

impl ServerListen {
    /// Stop routing first, so open connections close right away; then, unless
    /// the whole connection is closing (which ends every listen anyway), ask
    /// the server to stop listening.
    async fn stop(self, handle: &client::Handle<SshHandler>, cancel_on_server: bool) {
        self.routes.release(self.port, &self.owner);
        if cancel_on_server {
            let cancel = handle.cancel_tcpip_forward(self.address.clone(), u32::from(self.port));
            let _ = tokio::time::timeout(SERVER_REQUEST_TIMEOUT, cancel).await;
        }
    }

    /// Cancel without waiting: for a request that timed out, whose grant may
    /// still arrive.
    fn cancel_in_background(&self, handle: &Arc<client::Handle<SshHandler>>) {
        let handle = Arc::clone(handle);
        let (address, port) = (self.address.clone(), u32::from(self.port));
        tokio::spawn(async move {
            let cancel = handle.cancel_tcpip_forward(address, port);
            let _ = tokio::time::timeout(SERVER_REQUEST_TIMEOUT, cancel).await;
        });
    }
}

impl Drop for ServerListen {
    fn drop(&mut self) {
        self.routes.release(self.port, &self.owner);
    }
}

/// One forward a live tunnel serves: its reported status plus, when it
/// started, what keeps it serving.
struct ActiveForward {
    status: ForwardStatus,
    binding: Option<Binding>,
}

impl ActiveForward {
    /// Stop serving; `cancel_on_server` as for [`ServerListen::stop`].
    async fn release(self, handle: &client::Handle<SshHandler>, cancel_on_server: bool) {
        match self.binding {
            Some(Binding::Listener(listener)) => listener.stop().await,
            Some(Binding::Server(listen)) => listen.stop(handle, cancel_on_server).await,
            None => {}
        }
    }
}

/// The forwards a live tunnel currently serves, in the order they were added.
/// A forward whose port failed to bind stays listed (`bound: false`) so the
/// frontend can flag it.
struct ActiveForwards {
    handle: Arc<client::Handle<SshHandler>>,
    routes: Arc<RemoteRoutes>,
    entries: Vec<ActiveForward>,
}

impl ActiveForwards {
    fn new(handle: Arc<client::Handle<SshHandler>>, routes: Arc<RemoteRoutes>) -> Self {
        ActiveForwards {
            handle,
            routes,
            entries: Vec::new(),
        }
    }

    /// Bind `forward` (re-binding it if already present). A bind failure is
    /// recorded as `bound: false`; it never affects the other forwards.
    async fn add(&mut self, forward: &Forward) {
        self.remove(&forward.id).await;
        let binding = self.bind(forward).await;
        self.entries.push(ActiveForward {
            status: forward_status(forward, binding.is_some()),
            binding,
        });
    }

    async fn bind(&self, forward: &Forward) -> Option<Binding> {
        if forward.kind == ForwardKind::Remote {
            return self.bind_on_server(forward).await;
        }
        let (listener, destination) = listen(forward).await?;
        let handle = Arc::clone(&self.handle);
        let task = tokio::spawn(run_listener(listener, handle, destination));
        Some(Binding::Listener(LocalListener(task)))
    }

    /// Ask the server to listen for a remote forward. The route goes in first,
    /// so a connection arriving right after the server's reply finds it; a
    /// refused or timed-out request drops the listen, and with it the route,
    /// so a grant that comes late carries no connections.
    async fn bind_on_server(&self, forward: &Forward) -> Option<Binding> {
        let listen = self.claim_route(forward)?;
        let request = self
            .handle
            .tcpip_forward(listen.address.clone(), u32::from(listen.port));
        let reply = tokio::time::timeout(SERVER_REQUEST_TIMEOUT, request).await;
        if reply.is_err() {
            listen.cancel_in_background(&self.handle);
        }
        matches!(reply, Ok(Ok(_))).then_some(Binding::Server(listen))
    }

    /// `None` when another forward's route holds the server port.
    fn claim_route(&self, forward: &Forward) -> Option<ServerListen> {
        let (port, owner) = (forward.remote_port, forward.id.as_str());
        let target = forward.local_addr.clone();
        let claimed = self.routes.claim(port, owner, target, forward.local_port);
        claimed.then(|| ServerListen {
            address: forward.remote_host.clone(),
            port,
            owner: owner.to_string(),
            routes: Arc::clone(&self.routes),
        })
    }

    async fn remove(&mut self, forward_id: &str) {
        if let Some(index) = self
            .entries
            .iter()
            .position(|e| e.status.forward_id == forward_id)
        {
            self.entries.remove(index).release(&self.handle, true).await;
        }
    }

    /// Release every forward as the tunnel ends: the disconnect that follows
    /// ends the server's listens, so an unresponsive server can't hold it up.
    async fn clear(&mut self) {
        for entry in std::mem::take(&mut self.entries) {
            entry.release(&self.handle, false).await;
        }
    }

    fn any_bound(&self) -> bool {
        self.entries.iter().any(|e| e.binding.is_some())
    }

    fn statuses(&self) -> Vec<ForwardStatus> {
        self.entries.iter().map(|e| e.status.clone()).collect()
    }

    /// Apply a control received while serving; `false` means the tunnel should
    /// end (a stop, a dropped handle, or no bound forward left).
    async fn apply(&mut self, control: Option<TunnelControl>) -> bool {
        match control {
            Some(TunnelControl::AddForward(forward)) => self.add(&forward).await,
            Some(TunnelControl::RemoveForward(id)) => self.remove(&id).await,
            Some(TunnelControl::Stop) | None => return false,
        }
        self.any_bound()
    }
}

/// A forward's entry in a `Listening` status.
fn forward_status(forward: &Forward, bound: bool) -> ForwardStatus {
    ForwardStatus {
        forward_id: forward.id.clone(),
        local_addr: forward.local_addr.clone(),
        local_port: forward.local_port,
        remote_host: forward.remote_host.clone(),
        remote_port: forward.remote_port,
        bound,
    }
}

/// Where a forward's connections go: one fixed target (`ssh -L`) or wherever
/// each SOCKS client asks (`ssh -D`).
#[derive(Clone)]
enum Destination {
    Fixed { host: String, port: u16 },
    Socks,
}

impl Destination {
    /// `None` for a remote forward (the server listens for it) and for a kind
    /// this version doesn't know (written by a newer one; left unbound).
    fn of(forward: &Forward) -> Option<Self> {
        match forward.kind {
            ForwardKind::Local => Some(Destination::Fixed {
                host: forward.remote_host.clone(),
                port: forward.remote_port,
            }),
            ForwardKind::Dynamic => Some(Destination::Socks),
            // A remote forward listens on the server, never here.
            ForwardKind::Remote | ForwardKind::Unsupported => None,
        }
    }
}

/// Bind one forward's listener, or `None` when it can't serve: an unknown
/// kind, a non-loopback address, or a port already in use. Loopback is checked
/// again here, not only when a device is saved, so a hand-edited
/// `devices.json` can never expose a forward — least of all an open SOCKS
/// proxy — to the network (SPEC §8).
async fn listen(forward: &Forward) -> Option<(TcpListener, Destination)> {
    let destination = Destination::of(forward)?;
    if !is_loopback(&forward.local_addr) {
        return None;
    }
    let listener = TcpListener::bind((forward.local_addr.as_str(), forward.local_port))
        .await
        .ok()?;
    Some((listener, destination))
}

fn is_loopback(addr: &str) -> bool {
    addr.parse::<std::net::IpAddr>()
        .is_ok_and(|ip| ip.is_loopback())
}

/// How long a SOCKS client gets to send its request before its connection is
/// dropped, so an idle or non-SOCKS client can't hold a task forever.
const SOCKS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// Accept loop for one forward: every accepted local connection opens a
/// `direct-tcpip` channel and is copied bidirectionally. Per-connection tasks
/// live in a local `JoinSet` that is reaped as connections finish (bounding
/// memory) and dropped — aborting any in-flight copies — when this loop ends
/// (i.e. when the listener is aborted on forward removal or tunnel stop).
async fn run_listener(
    listener: TcpListener,
    handle: Arc<client::Handle<SshHandler>>,
    destination: Destination,
) {
    let mut conns = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((tcp, peer)) => {
                    conns.spawn(handle_connection(
                        tcp,
                        Arc::clone(&handle),
                        destination.clone(),
                        peer,
                    ));
                }
                // Usually transient (e.g. out of file descriptors): back off and
                // keep the forward alive rather than silently ending it.
                Err(_) => tokio::time::sleep(ACCEPT_RETRY_DELAY).await,
            },
            // Reap finished connection tasks so the set doesn't grow unbounded
            // over a long-lived tunnel serving many short connections.
            _ = conns.join_next(), if !conns.is_empty() => {}
        }
    }
}

/// Copy one accepted local connection to a fresh `direct-tcpip` channel and
/// back until either side closes. A failure (channel open, SOCKS handshake)
/// only drops this local connection; it never affects the tunnel.
async fn handle_connection(
    tcp: TcpStream,
    handle: Arc<client::Handle<SshHandler>>,
    destination: Destination,
    peer: SocketAddr,
) {
    match destination {
        Destination::Fixed { host, port } => forward_fixed(tcp, &handle, host, port, peer).await,
        Destination::Socks => forward_socks(tcp, &handle, peer).await,
    }
}

/// `ssh -L`: a channel-open failure drops the local connection (the DB client
/// sees a closed socket).
async fn forward_fixed(
    tcp: TcpStream,
    handle: &client::Handle<SshHandler>,
    host: String,
    port: u16,
    peer: SocketAddr,
) {
    if let Ok(channel) = open_direct_tcpip(handle, host, port, peer).await {
        pump(tcp, channel).await;
    }
}

/// `ssh -D`: learn the target from the SOCKS request, open the channel, and
/// tell the client whether it worked before pumping.
async fn forward_socks(mut tcp: TcpStream, handle: &client::Handle<SshHandler>, peer: SocketAddr) {
    let Some(request) = socks_handshake(&mut tcp, SOCKS_HANDSHAKE_TIMEOUT).await else {
        return;
    };
    let opened = open_direct_tcpip(handle, request.host, request.port, peer).await;
    let _ = socks::reply(&mut tcp, request.version, socks_outcome(&opened)).await;
    match opened {
        Ok(channel) => pump(tcp, channel).await,
        Err(_) => socks::close(&mut tcp).await,
    }
}

/// Read the client's SOCKS request within `timeout`. A rejected request has
/// already been answered, so the stream is closed gracefully; a client that
/// timed out is simply dropped.
async fn socks_handshake<S>(stream: &mut S, timeout: Duration) -> Option<socks::ConnectRequest>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    match tokio::time::timeout(timeout, socks::accept(stream)).await {
        Ok(Ok(request)) => Some(request),
        Ok(Err(_)) => {
            socks::close(stream).await;
            None
        }
        Err(_) => None,
    }
}

/// What to tell the SOCKS client about the `direct-tcpip` open, so it can show
/// "connection refused" or "not allowed" instead of a generic failure.
fn socks_outcome<T>(opened: &Result<T, russh::Error>) -> socks::Reply {
    match opened {
        Ok(_) => socks::Reply::Granted,
        Err(russh::Error::ChannelOpenFailure(reason)) => open_failure_reply(reason),
        Err(_) => socks::Reply::GeneralFailure,
    }
}

fn open_failure_reply(reason: &ChannelOpenFailure) -> socks::Reply {
    match reason {
        ChannelOpenFailure::ConnectFailed => socks::Reply::ConnectionRefused,
        ChannelOpenFailure::AdministrativelyProhibited => socks::Reply::NotAllowed,
        _ => socks::Reply::GeneralFailure,
    }
}

async fn open_direct_tcpip(
    handle: &client::Handle<SshHandler>,
    host: String,
    port: u16,
    peer: SocketAddr,
) -> Result<Channel<client::Msg>, russh::Error> {
    handle
        .channel_open_direct_tcpip(
            host,
            u32::from(port),
            peer.ip().to_string(),
            u32::from(peer.port()),
        )
        .await
}

async fn pump(mut tcp: TcpStream, channel: Channel<client::Msg>) {
    let mut stream = channel.into_stream();
    let _ = copy_bidirectional(&mut tcp, &mut stream).await;
}

/// Serve the tunnel — applying and reporting forward adds/removes as they
/// arrive — until a stop is requested, no bound forward is left, or the
/// transport dies. russh
/// drives the actual keepalive pings and dead-peer detection natively from the
/// connection's `client::Config` (see `KeepaliveConfig`); this loop additionally
/// probes the handle at the configured cadence (a failed send means the
/// connection is gone) and — keepalive or not — notices a transport russh has
/// already seen end (e.g. the server closed it), so the tunnel never keeps
/// reporting Listening over a dead connection.
async fn serve_until_stopped(
    handle: &Arc<client::Handle<SshHandler>>,
    control_rx: &mut mpsc::Receiver<TunnelControl>,
    keepalive: KeepaliveConfig,
    active: &mut ActiveForwards,
    publisher: &Publisher,
) -> ServeEnd {
    let mut probe = keepalive.interval.map(|interval| {
        let mut probe = tokio::time::interval_at(tokio::time::Instant::now() + interval, interval);
        probe.set_missed_tick_behavior(MissedTickBehavior::Delay);
        probe
    });
    let mut transport_check = tokio::time::interval(TRANSPORT_CHECK_INTERVAL);
    transport_check.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            control = control_rx.recv() => {
                if !active.apply(control).await {
                    return ServeEnd::Stopped;
                }
                publisher.listening(active.statuses());
            }
            alive = send_probe(handle, probe.as_mut()) => {
                if !alive {
                    return ServeEnd::ConnectionLost;
                }
            }
            _ = transport_check.tick() => {
                if handle.is_closed() {
                    return ServeEnd::ConnectionLost;
                }
            }
        }
    }
}

/// Wait for the next keepalive tick and ping; `false` when the ping fails.
/// Never resolves with keepalive disabled.
async fn send_probe(
    handle: &Arc<client::Handle<SshHandler>>,
    probe: Option<&mut tokio::time::Interval>,
) -> bool {
    let Some(probe) = probe else {
        return std::future::pending().await;
    };
    probe.tick().await;
    handle.send_keepalive(false).await.is_ok()
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
    fn socks_outcome_maps_channel_open_failures() {
        let refused: Result<(), _> = Err(russh::Error::ChannelOpenFailure(
            ChannelOpenFailure::ConnectFailed,
        ));
        let prohibited: Result<(), _> = Err(russh::Error::ChannelOpenFailure(
            ChannelOpenFailure::AdministrativelyProhibited,
        ));
        let shortage: Result<(), _> = Err(russh::Error::ChannelOpenFailure(
            ChannelOpenFailure::ResourceShortage,
        ));
        let other: Result<(), _> = Err(russh::Error::SendError);
        assert_eq!(
            socks_outcome(&Ok::<(), russh::Error>(())),
            socks::Reply::Granted
        );
        assert_eq!(socks_outcome(&refused), socks::Reply::ConnectionRefused);
        assert_eq!(socks_outcome(&prohibited), socks::Reply::NotAllowed);
        assert_eq!(socks_outcome(&shortage), socks::Reply::GeneralFailure);
        assert_eq!(socks_outcome(&other), socks::Reply::GeneralFailure);
    }

    #[test]
    fn only_loopback_addresses_may_be_bound() {
        assert!(is_loopback("127.0.0.1"));
        assert!(is_loopback("127.4.5.6"));
        assert!(is_loopback("::1"));
        assert!(!is_loopback("0.0.0.0"));
        assert!(!is_loopback("192.168.1.10"));
        assert!(!is_loopback("localhost"));
    }

    fn forward_of(kind: ForwardKind, local_addr: &str) -> Forward {
        Forward {
            id: "f1".into(),
            name: "f".into(),
            kind,
            local_addr: local_addr.into(),
            local_port: 0, // any free port
            remote_host: "db".into(),
            remote_port: 5432,
        }
    }

    #[tokio::test]
    async fn listen_refuses_non_loopback_and_unsupported_forwards() {
        assert!(listen(&forward_of(ForwardKind::Dynamic, "0.0.0.0"))
            .await
            .is_none());
        assert!(listen(&forward_of(ForwardKind::Unsupported, "127.0.0.1"))
            .await
            .is_none());
        // A remote forward's port is the server's: nothing binds here.
        assert!(listen(&forward_of(ForwardKind::Remote, "127.0.0.1"))
            .await
            .is_none());
        assert!(listen(&forward_of(ForwardKind::Dynamic, "127.0.0.1"))
            .await
            .is_some());
    }

    #[tokio::test]
    async fn socks_handshake_drops_a_silent_client_after_the_timeout() {
        let (_client, mut server) = tokio::io::duplex(64);
        let handshake = socks_handshake(&mut server, Duration::from_millis(50));
        let request = tokio::time::timeout(Duration::from_secs(1), handshake)
            .await
            .expect("the handshake must time out");
        assert!(request.is_none());
    }

    #[tokio::test]
    async fn socks_handshake_answers_then_closes_a_rejected_request() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (mut client, mut server) = tokio::io::duplex(64);
        // SOCKS4 BIND: rejected with 0x5B.
        client
            .write_all(&[4, 2, 0, 80, 127, 0, 0, 1, 0])
            .await
            .unwrap();
        let server_side =
            tokio::spawn(async move { socks_handshake(&mut server, Duration::from_secs(5)).await });
        let mut answer = Vec::new();
        client.read_to_end(&mut answer).await.unwrap();
        assert_eq!(answer, vec![0, 0x5B, 0, 0, 0, 0, 0, 0]);
        client.shutdown().await.unwrap();
        assert!(server_side.await.unwrap().is_none());
    }

    #[test]
    fn tunnel_info_is_camel_case() {
        let value = serde_json::to_value(TunnelInfo {
            tunnel_id: "t1".into(),
            device_id: "d1".into(),
            forward_ids: vec!["f1".into()],
            forwards: Vec::new(),
        })
        .unwrap();
        assert_eq!(value["tunnelId"], "t1");
        assert_eq!(value["deviceId"], "d1");
        assert_eq!(value["forwardIds"], serde_json::json!(["f1"]));
        assert_eq!(value["forwards"], serde_json::json!([]));
    }

    #[test]
    fn queue_applies_forward_changes_made_while_connecting() {
        let mut pending = vec![forward_of(ForwardKind::Local, "127.0.0.1")];
        let mut second = forward_of(ForwardKind::Local, "127.0.0.1");
        second.id = "f2".into();

        assert!(queue(&mut pending, TunnelControl::AddForward(second)));
        assert!(queue(
            &mut pending,
            TunnelControl::RemoveForward("f1".into())
        ));
        let ids: Vec<&str> = pending.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, ["f2"]);
    }

    #[test]
    fn queue_gives_up_on_stop_or_when_no_forward_is_left() {
        let mut pending = vec![forward_of(ForwardKind::Local, "127.0.0.1")];
        assert!(!queue(&mut pending.clone(), TunnelControl::Stop));
        assert!(!queue(
            &mut pending,
            TunnelControl::RemoveForward("f1".into())
        ));
    }
}
