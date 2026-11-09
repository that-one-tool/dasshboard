//! The forwards a live tunnel serves, of every kind, and how each started.

use std::sync::Arc;

use russh::client;

use super::local::LocalListener;
use super::remote::{ListenReply, ListenRequest, ServerListen, ServerRequests};
use super::status::forward_status;
use super::{ForwardStatus, TunnelControl};
use crate::device::{Forward, ForwardKind};
use crate::error::AppError;
use crate::relay::Pace;
use crate::remote_forward::RemoteRoutes;
use crate::ssh::handler::SshHandler;

/// What keeps a started forward serving. Each kind cleans up when dropped, so
/// a forward dropped without `release` (e.g. its tunnel task aborted, or a
/// refused request) never leaves a port bound or connections routed.
pub(super) enum Binding {
    /// `-L` / `-D`: the accept loop on the local port.
    Listener(LocalListener),
    /// `-R`: the server listens; its connections are routed here.
    Server(ServerListen),
}

/// One forward a live tunnel serves: its reported status plus, when it
/// started (or is waiting on the server to), what keeps it serving.
struct ActiveForward {
    status: ForwardStatus,
    binding: Option<Binding>,
    /// The listen request the server has yet to answer, for a remote forward.
    pending: Option<u64>,
    /// A remote forward: the server, not this machine, decides if it starts.
    remote: bool,
}

impl ActiveForward {
    fn new(forward: &Forward, binding: Option<Binding>, pending: Option<u64>) -> Self {
        let bound = binding.is_some() && pending.is_none();
        ActiveForward {
            status: forward_status(forward, bound),
            binding,
            pending,
            remote: forward.kind == ForwardKind::Remote,
        }
    }

    /// Stop serving; `requests` as for [`ServerListen::release`].
    async fn release(self, requests: Option<&ServerRequests>) {
        match self.binding {
            Some(Binding::Listener(listener)) => listener.stop().await,
            Some(Binding::Server(listen)) => listen.release(requests),
            None => {}
        }
    }
}

/// The forwards a live tunnel currently serves, in the order they were added.
/// A forward whose port failed to bind stays listed (`bound: false`) so the
/// frontend can flag it.
pub(super) struct ActiveForwards {
    handle: Arc<client::Handle<SshHandler>>,
    routes: Arc<RemoteRoutes>,
    requests: ServerRequests,
    /// The last listen request's number.
    attempts: u64,
    pace: Pace,
    entries: Vec<ActiveForward>,
}

impl ActiveForwards {
    pub(super) fn new(
        handle: Arc<client::Handle<SshHandler>>,
        routes: Arc<RemoteRoutes>,
        pace: Pace,
    ) -> Self {
        ActiveForwards {
            requests: ServerRequests::start(Arc::clone(&handle)),
            handle,
            routes,
            attempts: 0,
            pace,
            entries: Vec::new(),
        }
    }

    /// Bind `forward` (re-binding it if already present). A bind failure is
    /// recorded as `bound: false`; it never affects the other forwards. A
    /// remote forward waits for the server's answer (see [`Self::settle`]).
    pub(super) async fn add(&mut self, forward: &Forward) {
        self.remove(&forward.id).await;
        let entry = if forward.kind == ForwardKind::Remote {
            self.listen_on_server(forward)
        } else {
            ActiveForward::new(forward, self.bind(forward).await, None)
        };
        self.entries.push(entry);
    }

    async fn bind(&self, forward: &Forward) -> Option<Binding> {
        let handle = Arc::clone(&self.handle);
        let listener = LocalListener::start(forward, handle, self.pace).await?;
        Some(Binding::Listener(listener))
    }

    /// Ask the server to listen for a remote forward. The route goes in first,
    /// so a connection arriving right after the server's reply finds it; a
    /// refused or timed-out request drops the listen, and with it the route,
    /// so a grant that comes late carries no connections.
    fn listen_on_server(&mut self, forward: &Forward) -> ActiveForward {
        let Some(listen) = self.claim_route(forward) else {
            return ActiveForward::new(forward, None, None);
        };
        self.attempts += 1;
        self.requests.listen(ListenRequest {
            attempt: self.attempts,
            address: listen.address.clone(),
            port: listen.port,
        });
        ActiveForward::new(forward, Some(Binding::Server(listen)), Some(self.attempts))
    }

    /// The server's next answer to a listen request.
    pub(super) async fn next_reply(&mut self) -> Option<ListenReply> {
        self.requests.replies.recv().await
    }

    /// Apply the server's answer to the entry that asked, if it is still
    /// there; `false` when no forward is left serving.
    pub(super) fn settle(&mut self, reply: Option<ListenReply>) -> bool {
        let Some(reply) = reply else {
            return self.any_bound();
        };
        if let Some(entry) = self
            .entries
            .iter_mut()
            .find(|e| e.pending == Some(reply.attempt))
        {
            entry.pending = None;
            entry.status.bound = reply.granted;
            entry.binding = entry.binding.take().filter(|_| reply.granted);
        }
        self.any_bound()
    }

    /// Wait until the server has answered every listen request made so far.
    pub(super) async fn await_replies(&mut self) {
        while self.entries.iter().any(|e| e.pending.is_some()) {
            let reply = self.next_reply().await;
            if reply.is_none() {
                return;
            }
            self.settle(reply);
        }
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
            self.entries
                .remove(index)
                .release(Some(&self.requests))
                .await;
        }
    }

    /// Release every forward as the tunnel ends: the disconnect that follows
    /// ends the server's listens, so an unresponsive server can't hold it up.
    pub(super) async fn clear(&mut self) {
        for entry in std::mem::take(&mut self.entries) {
            entry.release(None).await;
        }
    }

    /// Whether any forward serves, or may once the server answers.
    pub(super) fn any_bound(&self) -> bool {
        self.entries.iter().any(|e| e.binding.is_some())
    }

    /// Why none of the forwards started. A server that refused a remote
    /// forward may only be holding its port for a session of ours that just
    /// dropped, so that is worth a retry; a local port in use is not.
    pub(super) fn none_started(&self) -> AppError {
        if self.entries.iter().any(|e| e.remote) {
            return AppError::SshConnect(
                "the server refused the tunnel's remote forwards (it may still hold their \
                 ports from an earlier connection)"
                    .to_string(),
            );
        }
        AppError::TunnelBind("none of the tunnel's forwards could be started".to_string())
    }

    pub(super) fn ids(&self) -> Vec<String> {
        self.entries
            .iter()
            .map(|e| e.status.forward_id.clone())
            .collect()
    }

    /// The statuses of the forwards the server isn't still deciding about.
    pub(super) fn statuses(&self) -> Vec<ForwardStatus> {
        self.entries
            .iter()
            .filter(|e| e.pending.is_none())
            .map(|e| e.status.clone())
            .collect()
    }

    /// Apply a control received while serving; `false` means the tunnel should
    /// end (a dropped handle, or no bound forward left).
    pub(super) async fn apply(&mut self, control: Option<TunnelControl>) -> bool {
        match control {
            Some(TunnelControl::AddForward(forward)) => self.add(&forward).await,
            Some(TunnelControl::RemoveForward(id)) => self.remove(&id).await,
            None => return false,
        }
        self.any_bound()
    }
}
