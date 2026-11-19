//! One tunnel task from connect to teardown.

use std::sync::Arc;

use russh::client;
use tokio::sync::mpsc;

use super::forwards::ActiveForwards;
use super::manager::Controls;
use super::serve::{bind_until_stop, serve_until_stopped, ServeEnd};
use super::status::Publisher;
use super::{TunnelControl, TunnelParams};
use crate::device::Forward;
use crate::error::AppError;
use crate::relay::Pace;
use crate::remote_forward::RemoteRoutes;
use crate::ssh::connector::{SshConnection, SshConnector};
use crate::ssh::handler::SshHandler;

/// How a tunnel connects, and the pace its forwarded connections' local
/// clients must keep.
pub(super) struct TunnelContext {
    pub(super) ssh: Arc<SshConnector>,
    pub(super) pace: Pace,
}

/// The full lifecycle of one tunnel task: connect+auth (racing an early stop,
/// and queuing forward changes made meanwhile), bind the forwards, then serve
/// until stopped, the last bound forward is released, or the transport drops.
/// Returns `Ok(())` for any clean end and `Err` for a failure that should
/// surface as `tunnel_status: error`.
pub(super) async fn run_tunnel(
    mut params: TunnelParams,
    mut handler: SshHandler,
    routes: Arc<RemoteRoutes>,
    TunnelContext { ssh, pace }: TunnelContext,
    publisher: Publisher,
    mut controls: Controls,
) -> Result<(), AppError> {
    // Abandons a pending host-key prompt if this returns mid-handshake.
    let _owner = handler.take_owner_token();
    let connected =
        connect_until_stop(&mut params, handler, &ssh, &mut controls, &publisher).await?;
    let Some(connection) = connected else {
        return Ok(());
    };
    let handle = connection.handle();
    let mut active = ActiveForwards::new(Arc::clone(handle), routes, pace);
    let end = bind_and_serve(handle, &mut active, &params, &mut controls, &publisher).await;

    // Abort every listener (which cascades to their in-flight connection tasks),
    // then close the SSH transport cleanly.
    active.clear().await;
    connection.close().await;
    end?.into_result()
}

/// Connect and authenticate, applying the forward changes made meanwhile to
/// `params.forwards`; `None` when a stop (or every forward released) came
/// first.
async fn connect_until_stop(
    params: &mut TunnelParams,
    handler: SshHandler,
    ssh: &SshConnector,
    controls: &mut Controls,
    publisher: &Publisher,
) -> Result<Option<SshConnection>, AppError> {
    let target = &params.target;
    tokio::select! {
        biased;
        // A stop (or every forward released) during the handshake aborts:
        // dropping the `establish` future drops the handler (and any
        // PromptGuard within), cleaning up a pending host-key prompt too.
        _ = queue_until_stop(controls, &mut params.forwards, publisher) => Ok(None),
        result = ssh.connect(target.endpoint(), target.jump.as_ref(), handler) => result.map(Some),
    }
}

/// Bind the forwards, then serve them. `Err` when none of them started.
async fn bind_and_serve(
    handle: &Arc<client::Handle<SshHandler>>,
    active: &mut ActiveForwards,
    params: &TunnelParams,
    controls: &mut Controls,
    publisher: &Publisher,
) -> Result<ServeEnd, AppError> {
    if !bind_until_stop(active, &params.forwards, &mut controls.stop).await {
        return Ok(ServeEnd::Stopped);
    }
    if !active.any_bound() {
        return Err(active.none_started());
    }
    publisher.listening(active);
    let keepalive = params.target.keepalive;
    Ok(serve_until_stopped(handle, controls, keepalive, active, publisher).await)
}

/// Apply forward changes requested while the tunnel is still connecting to the
/// set it will bind; returns on a stop, a dropped handle, or once no forward is
/// left to bind.
async fn queue_until_stop(
    controls: &mut Controls,
    pending: &mut Vec<Forward>,
    publisher: &Publisher,
) {
    tokio::select! {
        _ = controls.stop.wait_for(|requested| *requested) => {}
        () = queue_until_empty(&mut controls.queue, pending, publisher) => {}
    }
}

async fn queue_until_empty(
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
/// tunnel should not go ahead (nothing left to bind).
fn queue(pending: &mut Vec<Forward>, control: TunnelControl) -> bool {
    match control {
        TunnelControl::AddForward(forward) => {
            pending.retain(|f| f.id != forward.id);
            pending.push(forward);
        }
        TunnelControl::RemoveForward(id) => pending.retain(|f| f.id != id),
    }
    !pending.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::ForwardKind;
    use crate::tunnel::tests::forward_of;

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
    fn queue_gives_up_when_no_forward_is_left() {
        let mut pending = vec![forward_of(ForwardKind::Local, "127.0.0.1")];
        assert!(!queue(
            &mut pending,
            TunnelControl::RemoveForward("f1".into())
        ));
    }
}
