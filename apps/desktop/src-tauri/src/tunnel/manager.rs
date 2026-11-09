//! The registry of live tunnels: spawn, stop, forward changes, prompts.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{mpsc, watch};

use super::lifecycle::{run_tunnel, TunnelTimeouts};
use super::status::{forward_ids, lock_snapshot, ForwardSnapshot, Publisher};
use super::{TunnelControl, TunnelInfo, TunnelParams, TunnelSink, TunnelStatus};
use crate::device::Forward;
use crate::error::AppError;
use crate::known_hosts::KnownHostsStore;
use crate::relay::Pace;
use crate::remote_forward::RemoteRoutes;
use crate::ssh::establish::{
    overall_establish_timeout, DEFAULT_CONNECT_TIMEOUT, DEFAULT_HANDSHAKE_TIMEOUT,
    DEFAULT_PROMPT_TIMEOUT,
};
use crate::ssh::handler::SshHandler;
use crate::ssh::prompts::{AuthAnswers, ConnectPrompter, ConnectPrompts};

/// Control-channel bound. A tunnel's control channel carries the occasional
/// user-driven forward add/remove and a final `Stop`; the bound just keeps it
/// from being unbounded (a standing review concern), mirroring `session.rs`.
const CONTROL_CHANNEL_CAPACITY: usize = 8;

/// The manager's per-tunnel handle: the control `Sender`, the owning device id
/// and the last-reported forwards (so `list_tunnels` can describe each live
/// tunnel). Dropping every clone of the sender makes the task's
/// `control_rx.recv()` return `None`, which the task treats as a stop.
struct TunnelHandle {
    control: mpsc::Sender<TunnelControl>,
    /// Set by `stop_tunnel` (see [`Controls`]).
    stop: watch::Sender<bool>,
    device_id: String,
    forwards: ForwardSnapshot,
}

/// What drives a tunnel task: the queued forward changes, and the stop flag,
/// out of band so a stop never waits behind the first binds, which wait for
/// the server's answers about remote forwards (up to `SERVER_REQUEST_TIMEOUT`).
pub(super) struct Controls {
    pub(super) queue: mpsc::Receiver<TunnelControl>,
    pub(super) stop: watch::Receiver<bool>,
}

/// Owns all live tunnels. Lives in Tauri managed state behind an `Arc` (see
/// `AppState`). Shares the host-key TOFU store with `SessionManager` so a trust
/// decision made for a shell applies to a tunnel to the same host and vice
/// versa; its own `ConnectPrompts` is resolved by the `respond_host_key` command
/// fanning a response out to both managers.
pub struct TunnelManager {
    tunnels: Mutex<HashMap<String, TunnelHandle>>,
    prompts: Arc<ConnectPrompts>,
    known_hosts: Arc<KnownHostsStore>,
    connect_timeout: Duration,
    prompt_timeout: Duration,
    handshake_timeout: Duration,
    pace: Pace,
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
            prompts: Arc::new(ConnectPrompts::default()),
            known_hosts,
            connect_timeout,
            prompt_timeout,
            handshake_timeout,
            pace: Pace::DEFAULT,
        }
    }

    /// Read a forwarded connection's channel at most `limit` bytes ahead of its
    /// local client (default: [`Pace::DEFAULT`]); tests change it.
    pub fn with_backlog_limit(mut self, limit: usize) -> Self {
        self.pace.backlog = limit;
        self
    }

    /// Close a forwarded connection whose local client, that far behind,
    /// stops reading for `timeout` (default: [`Pace::DEFAULT`]); tests change it.
    pub fn with_stall_timeout(mut self, timeout: Duration) -> Self {
        self.pace.stall = timeout;
        self
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

    /// Spawn a live tunnel. Inserts the handle synchronously (so the map reflects
    /// the tunnel the instant this returns) and drives the rest on a tokio task
    /// that removes its own entry on exit.
    pub fn spawn_tunnel(
        self: &Arc<Self>,
        tunnel_id: String,
        params: TunnelParams,
        sink: Arc<dyn TunnelSink>,
    ) {
        let (controls, snapshot) = self.register(&tunnel_id, &params);
        let routes = Arc::new(RemoteRoutes::new(self.pace));
        let handler = self.handler_for(&params, &sink, &routes);
        let manager = Arc::clone(self);
        let timeouts = self.timeouts();

        tokio::spawn(async move {
            sink.on_status(TunnelStatus::Connecting, None, Vec::new());

            let publisher = Publisher {
                sink: Arc::clone(&sink),
                snapshot,
            };
            let result = run_tunnel(params, handler, routes, timeouts, publisher, controls).await;
            report_end(sink.as_ref(), result);

            manager.lock_tunnels().remove(&tunnel_id);
        });
    }

    /// Track a new tunnel; returns what drives its task and the snapshot of its
    /// forwards it keeps up to date.
    fn register(&self, tunnel_id: &str, params: &TunnelParams) -> (Controls, ForwardSnapshot) {
        let (control_tx, control_rx) = mpsc::channel(CONTROL_CHANNEL_CAPACITY);
        let (stop_tx, stop_rx) = watch::channel(false);
        let controls = Controls {
            queue: control_rx,
            stop: stop_rx,
        };
        let snapshot = ForwardSnapshot::default();
        lock_snapshot(&snapshot).forward_ids = forward_ids(&params.forwards);
        self.lock_tunnels().insert(
            tunnel_id.to_string(),
            TunnelHandle {
                control: control_tx,
                stop: stop_tx,
                device_id: params.device_id.clone(),
                forwards: Arc::clone(&snapshot),
            },
        );
        (controls, snapshot)
    }

    fn handler_for(
        &self,
        params: &TunnelParams,
        sink: &Arc<dyn TunnelSink>,
        routes: &Arc<RemoteRoutes>,
    ) -> SshHandler {
        // Tunnels never forward the SSH agent.
        SshHandler::new(
            Arc::clone(sink) as Arc<dyn ConnectPrompter>,
            Arc::clone(&self.known_hosts),
            Arc::clone(&self.prompts),
            params.host.clone(),
            params.port,
            self.prompt_timeout,
            params.keepalive,
        )
        .with_remote_routes(Arc::clone(routes))
    }

    fn timeouts(&self) -> TunnelTimeouts {
        TunnelTimeouts {
            connect: self.connect_timeout,
            overall: self.overall_establish_timeout(),
            pace: self.pace,
        }
    }

    /// Request a graceful stop. Idempotent: an unknown `tunnel_id` is a no-op.
    /// The task performs the actual map removal when it exits.
    pub async fn stop_tunnel(&self, tunnel_id: &str) {
        if let Some(handle) = self.lock_tunnels().get(tunnel_id) {
            handle.stop.send_replace(true);
        }
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

/// The tunnel's last status: disconnected after a clean end, else the error.
fn report_end(sink: &dyn TunnelSink, result: Result<(), AppError>) {
    match result {
        Ok(()) => sink.on_status(TunnelStatus::Disconnected, None, Vec::new()),
        // AppError messages are always secret-free (see error.rs).
        Err(err) => sink.on_error(&err),
    }
}
