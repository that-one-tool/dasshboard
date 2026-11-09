//! The serve loop of a connected tunnel: forward changes, the server's
//! answers, stop, and the connection watchdog.

use std::sync::Arc;
use std::time::Duration;

use russh::client;
use tokio::sync::watch;
use tokio::time::MissedTickBehavior;

use super::forwards::ActiveForwards;
use super::manager::Controls;
use super::remote::ListenReply;
use super::status::Publisher;
use super::TunnelControl;
use crate::device::Forward;
use crate::error::AppError;
use crate::ssh::handler::SshHandler;
use crate::ssh::params::KeepaliveConfig;

/// Why `serve_until_stopped` returned.
pub(super) enum ServeEnd {
    /// A stop was requested, the manager dropped the handle, or the last bound
    /// forward was released.
    Stopped,
    /// The SSH transport went away under the tunnel.
    ConnectionLost,
}

impl ServeEnd {
    /// A lost connection is an error the frontend reports; any other end is
    /// clean.
    pub(super) fn into_result(self) -> Result<(), AppError> {
        match self {
            ServeEnd::Stopped => Ok(()),
            ServeEnd::ConnectionLost => Err(AppError::SshConnect(
                "the SSH connection was lost".to_string(),
            )),
        }
    }
}

/// How often the serve loop checks whether russh has seen the transport end.
const TRANSPORT_CHECK_INTERVAL: Duration = Duration::from_secs(1);

/// Serve the tunnel — applying and reporting forward adds/removes as they
/// arrive — until a stop is requested, no bound forward is left, or the
/// transport dies. russh
/// drives the actual keepalive pings and dead-peer detection natively from the
/// connection's `client::Config` (see `KeepaliveConfig`); this loop additionally
/// probes the handle at the configured cadence (a failed send means the
/// connection is gone) and — keepalive or not — notices a transport russh has
/// already seen end (e.g. the server closed it), so the tunnel never keeps
/// reporting Listening over a dead connection.
pub(super) async fn serve_until_stopped(
    handle: &Arc<client::Handle<SshHandler>>,
    controls: &mut Controls,
    keepalive: KeepaliveConfig,
    active: &mut ActiveForwards,
    publisher: &Publisher,
) -> ServeEnd {
    let mut watchdog = Watchdog::new(keepalive);
    loop {
        let event = next_event(handle, controls, &mut watchdog, active).await;
        if let Some(end) = apply_event(event, active, controls, publisher).await {
            return end;
        }
    }
}

/// What woke the serve loop.
enum ServeEvent {
    Control(Option<TunnelControl>),
    Reply(Option<ListenReply>),
    /// The connection checked out fine.
    Healthy,
    End(ServeEnd),
}

async fn next_event(
    handle: &client::Handle<SshHandler>,
    controls: &mut Controls,
    watchdog: &mut Watchdog,
    active: &mut ActiveForwards,
) -> ServeEvent {
    tokio::select! {
        control = controls.queue.recv() => ServeEvent::Control(control),
        _ = controls.stop.wait_for(|requested| *requested) => ServeEvent::End(ServeEnd::Stopped),
        alive = watchdog.check(handle) => match alive {
            true => ServeEvent::Healthy,
            false => ServeEvent::End(ServeEnd::ConnectionLost),
        },
        reply = active.next_reply() => ServeEvent::Reply(reply),
    }
}

/// Act on `event`, reporting the forwards when they changed; `Some` when the
/// tunnel should end.
async fn apply_event(
    event: ServeEvent,
    active: &mut ActiveForwards,
    controls: &mut Controls,
    publisher: &Publisher,
) -> Option<ServeEnd> {
    let keep = match event {
        ServeEvent::End(end) => return Some(end),
        ServeEvent::Healthy => return None,
        ServeEvent::Control(control) => apply_until_stop(active, control, &mut controls.stop).await,
        ServeEvent::Reply(reply) => active.settle(reply),
    };
    report_or_end(keep, active, publisher)
}

/// Report the forwards after a change, or end the tunnel when none is left.
fn report_or_end(keep: bool, active: &ActiveForwards, publisher: &Publisher) -> Option<ServeEnd> {
    if !keep {
        return Some(ServeEnd::Stopped);
    }
    publisher.listening(active);
    None
}

/// Watches the connection: the keepalive probe at its cadence, and the
/// transport check that notices a connection russh already saw end.
struct Watchdog {
    probe: Option<tokio::time::Interval>,
    transport_check: tokio::time::Interval,
}

impl Watchdog {
    fn new(keepalive: KeepaliveConfig) -> Self {
        let probe = keepalive.interval.map(|interval| {
            let start = tokio::time::Instant::now() + interval;
            let mut probe = tokio::time::interval_at(start, interval);
            probe.set_missed_tick_behavior(MissedTickBehavior::Delay);
            probe
        });
        let mut transport_check = tokio::time::interval(TRANSPORT_CHECK_INTERVAL);
        transport_check.set_missed_tick_behavior(MissedTickBehavior::Delay);
        Watchdog {
            probe,
            transport_check,
        }
    }

    /// Wait for the next check; `false` when the connection is gone.
    async fn check(&mut self, handle: &client::Handle<SshHandler>) -> bool {
        tokio::select! {
            alive = send_probe(handle, self.probe.as_mut()) => alive,
            _ = self.transport_check.tick() => !handle.is_closed(),
        }
    }
}

/// Bind each forward (a failure on one is non-fatal to the others) and wait
/// for the server's answers about remote ones; `false` when a stop came first.
pub(super) async fn bind_until_stop(
    active: &mut ActiveForwards,
    forwards: &[Forward],
    stop: &mut watch::Receiver<bool>,
) -> bool {
    let bind_all = async {
        for forward in forwards {
            active.add(forward).await;
        }
        active.await_replies().await;
    };
    tokio::select! {
        () = bind_all => true,
        _ = stop.wait_for(|requested| *requested) => false,
    }
}

/// [`ActiveForwards::apply`], cut short by a stop; `false` when the tunnel
/// should end.
async fn apply_until_stop(
    active: &mut ActiveForwards,
    control: Option<TunnelControl>,
    stop: &mut watch::Receiver<bool>,
) -> bool {
    tokio::select! {
        keep = active.apply(control) => keep,
        _ = stop.wait_for(|requested| *requested) => false,
    }
}

/// Wait for the next keepalive tick and ping; `false` when the ping fails.
/// Never resolves with keepalive disabled.
async fn send_probe(
    handle: &client::Handle<SshHandler>,
    probe: Option<&mut tokio::time::Interval>,
) -> bool {
    let Some(probe) = probe else {
        return std::future::pending().await;
    };
    probe.tick().await;
    handle.send_keepalive(false).await.is_ok()
}
