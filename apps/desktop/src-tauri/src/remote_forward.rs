//! Remote port forwarding (`ssh -R`): the SSH server listens and opens a
//! `forwarded-tcpip` channel back to us per connection; this module routes each
//! one to its forward's local target. A tunnel (`tunnel.rs`) owns the routes —
//! adding one before asking the server to listen, removing it after cancelling
//! — and shares them with its connection's [`SshHandler`](crate::session),
//! which receives the channels.
//!
//! Routes are keyed by server port (validation keeps those unique per device),
//! so a server reporting the listen address differently from how it was asked
//! (`localhost` vs `127.0.0.1`) still finds the route. A channel for a port with
//! no route is rejected: the server can only reach what a forward names. Each
//! route belongs to one forward, so another forward (e.g. mid-way through an
//! edit that swaps two server ports) can neither take it over nor drop it.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use russh::{client, Channel, ChannelOpenFailure};
use tokio::io::copy_bidirectional;
use tokio::net::TcpStream;
use tokio::sync::watch;

use crate::stall_guard::{StallGuard, STALL_TIMEOUT};

/// How long dialing a local target may take before the server's channel is
/// refused (a filtered host would otherwise hold it for the OS's full timeout).
const LOCAL_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Where one server port's connections go, plus the switch that ends them:
/// every bridged connection watches `live`, so dropping the route (forward
/// removed, tunnel stopped) closes its connections too, as for `ssh -L`.
struct Route {
    owner: String,
    host: String,
    port: u16,
    live: watch::Sender<()>,
}

pub(crate) struct RemoteRoutes {
    routes: Mutex<HashMap<u16, Route>>,
    /// How long a bridged connection's local target may stop reading.
    stall_timeout: Duration,
}

impl Default for RemoteRoutes {
    fn default() -> Self {
        Self::new(STALL_TIMEOUT)
    }
}

impl RemoteRoutes {
    pub(crate) fn new(stall_timeout: Duration) -> Self {
        RemoteRoutes {
            routes: Mutex::default(),
            stall_timeout,
        }
    }

    /// Send connections to `server_port` on to `host:port` for forward `owner`
    /// (replacing, and closing the connections of, its own earlier route).
    /// `false` when another forward holds the port.
    pub(crate) fn claim(&self, server_port: u16, owner: &str, host: String, port: u16) -> bool {
        let mut routes = self.lock();
        if routes.get(&server_port).is_some_and(|r| r.owner != owner) {
            return false;
        }
        let (live, _) = watch::channel(());
        let owner = owner.to_string();
        routes.insert(
            server_port,
            Route {
                owner,
                host,
                port,
                live,
            },
        );
        true
    }

    /// Stop routing `server_port` and close its open connections, if `owner`
    /// still holds it.
    pub(crate) fn release(&self, server_port: u16, owner: &str) {
        let mut routes = self.lock();
        if routes.get(&server_port).is_some_and(|r| r.owner == owner) {
            routes.remove(&server_port);
        }
    }

    fn lookup(&self, connected_port: u32) -> Option<(String, u16, watch::Receiver<()>)> {
        let port = u16::try_from(connected_port).ok()?;
        let routes = self.lock();
        let route = routes.get(&port)?;
        Some((route.host.clone(), route.port, route.live.subscribe()))
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<u16, Route>> {
        self.routes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Serve one `forwarded-tcpip` channel the server opened. The dial runs on its
/// own task: the handler's callback drives the whole SSH connection.
pub(crate) fn serve_forwarded(
    routes: &RemoteRoutes,
    channel: Channel<client::Msg>,
    connected_port: u32,
    reply: client::ChannelOpenHandle,
) {
    match routes.lookup(connected_port) {
        Some((host, port, live)) => {
            let stall_timeout = routes.stall_timeout;
            tokio::spawn(bridge(host, port, live, channel, reply, stall_timeout));
        }
        // Dropping the reply rejects the channel (administratively prohibited).
        None => drop(reply),
    }
}

/// Accept the channel only once the local target answered, so a refused
/// target reads as "connect failed" to the server's client.
async fn bridge(
    host: String,
    port: u16,
    mut live: watch::Receiver<()>,
    channel: Channel<client::Msg>,
    reply: client::ChannelOpenHandle,
    stall_timeout: Duration,
) {
    let Some(tcp) = dial(&host, port).await else {
        reply.reject(ChannelOpenFailure::ConnectFailed).await;
        return;
    };
    reply.accept().await;
    let mut tcp = StallGuard::new(tcp, stall_timeout);
    let mut stream = channel.into_stream();
    tokio::select! {
        _ = copy_bidirectional(&mut tcp, &mut stream) => {}
        // Only ever an error: the route's sender was dropped.
        _ = live.changed() => {}
    }
}

async fn dial(host: &str, port: u16) -> Option<TcpStream> {
    tokio::time::timeout(LOCAL_CONNECT_TIMEOUT, TcpStream::connect((host, port)))
        .await
        .ok()?
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    fn claim(routes: &RemoteRoutes, owner: &str, server_port: u16, port: u16) -> bool {
        routes.claim(server_port, owner, "127.0.0.1".to_string(), port)
    }

    #[test]
    fn routes_a_server_port_to_its_local_target() {
        let routes = RemoteRoutes::default();
        assert!(claim(&routes, "r1", 8080, 3000));
        let (host, port, _) = routes.lookup(8080).expect("routed");
        assert_eq!((host.as_str(), port), ("127.0.0.1", 3000));
        assert!(routes.lookup(8081).is_none());
    }

    #[test]
    fn a_port_beyond_u16_is_never_routed() {
        let routes = RemoteRoutes::default();
        claim(&routes, "r1", 8080, 3000);
        assert!(routes.lookup(8080 + 65536).is_none());
    }

    #[tokio::test]
    async fn releasing_a_route_ends_its_connections() {
        let routes = RemoteRoutes::default();
        claim(&routes, "r1", 8080, 3000);
        let (_, _, mut live) = routes.lookup(8080).unwrap();
        routes.release(8080, "r1");
        assert!(routes.lookup(8080).is_none());
        assert!(live.changed().await.is_err());
    }

    #[tokio::test]
    async fn reclaiming_a_route_ends_the_old_connections() {
        let routes = RemoteRoutes::default();
        claim(&routes, "r1", 8080, 3000);
        let (_, _, mut old) = routes.lookup(8080).unwrap();
        assert!(claim(&routes, "r1", 8080, 4000));
        assert!(old.changed().await.is_err());
        assert_eq!(routes.lookup(8080).unwrap().1, 4000);
    }

    #[test]
    fn another_forward_can_neither_take_nor_drop_a_route() {
        let routes = RemoteRoutes::default();
        claim(&routes, "r1", 8080, 3000);
        assert!(!claim(&routes, "r2", 8080, 4000));
        routes.release(8080, "r2");
        assert_eq!(routes.lookup(8080).unwrap().1, 3000);
    }

    #[tokio::test]
    async fn dial_reaches_a_listening_target_and_not_a_closed_one() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let open = listener.local_addr().unwrap().port();
        assert!(dial("127.0.0.1", open).await.is_some());
        drop(listener);
        assert!(dial("127.0.0.1", open).await.is_none());
    }
}
