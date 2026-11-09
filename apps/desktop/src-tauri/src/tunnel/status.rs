//! What a tunnel reports: its `Listening` forward set to the frontend, and the
//! snapshot `list_tunnels` reads.

use std::sync::{Arc, Mutex};

use super::forwards::ActiveForwards;
use super::{ForwardStatus, TunnelSink, TunnelStatus};
use crate::device::Forward;

/// What `list_tunnels` reports about a tunnel's forwards: the ids it serves (or
/// will bind, while connecting) and their last-reported bind state.
#[derive(Default)]
pub(super) struct TunnelSnapshot {
    pub(super) forward_ids: Vec<String>,
    pub(super) forwards: Vec<ForwardStatus>,
}

/// Shared between a tunnel's task (writer) and the manager's `list` (reader).
pub(super) type ForwardSnapshot = Arc<Mutex<TunnelSnapshot>>;

/// Reports a tunnel's `Listening` forward set to the frontend and keeps the
/// manager's snapshot of it (for `list_tunnels`) in step.
pub(super) struct Publisher {
    pub(super) sink: Arc<dyn TunnelSink>,
    pub(super) snapshot: ForwardSnapshot,
}

impl Publisher {
    /// Record the forwards a still-connecting tunnel will bind (not reported to
    /// the frontend, which asked for them).
    pub(super) fn pending(&self, forwards: &[Forward]) {
        lock_snapshot(&self.snapshot).forward_ids = forward_ids(forwards);
    }

    /// Report the forwards that started or failed; one still waiting on the
    /// server is left out (the frontend shows it as starting) but stays in the
    /// snapshot's ids, as it will be served.
    pub(super) fn listening(&self, active: &ActiveForwards) {
        let forwards = active.statuses();
        *lock_snapshot(&self.snapshot) = TunnelSnapshot {
            forward_ids: active.ids(),
            forwards: forwards.clone(),
        };
        self.sink.on_status(TunnelStatus::Listening, None, forwards);
    }
}

pub(super) fn forward_ids(forwards: &[Forward]) -> Vec<String> {
    forwards.iter().map(|f| f.id.clone()).collect()
}

pub(super) fn lock_snapshot(
    snapshot: &ForwardSnapshot,
) -> std::sync::MutexGuard<'_, TunnelSnapshot> {
    snapshot
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A forward's entry in a `Listening` status.
pub(super) fn forward_status(forward: &Forward, bound: bool) -> ForwardStatus {
    ForwardStatus {
        forward_id: forward.id.clone(),
        local_addr: forward.local_addr.clone(),
        local_port: forward.local_port,
        remote_host: forward.remote_host.clone(),
        remote_port: forward.remote_port,
        bound,
    }
}
