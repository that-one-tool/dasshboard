//! Local listeners (`ssh -L` and the accept side of `ssh -D`): bind on
//! loopback, accept, and carry each connection over a `direct-tcpip` channel.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use russh::{client, Channel};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::{JoinHandle, JoinSet};

use super::dynamic::forward_socks;
use crate::device::{Forward, ForwardKind};
use crate::relay::{bridge, Pace};
use crate::ssh::handler::SshHandler;

/// Pause before accepting again after a failed `accept` (e.g. out of file
/// descriptors), so a transient failure doesn't end the forward or spin.
const ACCEPT_RETRY_DELAY: Duration = Duration::from_millis(250);

/// A local forward's accept-loop task. A dropped `JoinHandle` detaches rather
/// than aborts, hence the `Drop`.
pub(super) struct LocalListener(JoinHandle<()>);

impl LocalListener {
    /// Bind `forward` and start its accept loop; `None` when it can't serve
    /// (see [`listen`]).
    pub(super) async fn start(
        forward: &Forward,
        handle: Arc<client::Handle<SshHandler>>,
        pace: Pace,
    ) -> Option<Self> {
        let (listener, destination) = listen(forward).await?;
        let task = tokio::spawn(run_listener(listener, handle, destination, pace));
        Some(LocalListener(task))
    }

    /// Abort the accept loop and wait for it to drop its socket, so the port is
    /// free again by the time the change is reported.
    pub(super) async fn stop(mut self) {
        self.0.abort();
        let _ = (&mut self.0).await;
    }
}

impl Drop for LocalListener {
    fn drop(&mut self) {
        self.0.abort();
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

/// Accept loop for one forward: every accepted local connection opens a
/// `direct-tcpip` channel and is copied bidirectionally. Per-connection tasks
/// live in a local `JoinSet` that is reaped as connections finish (bounding
/// memory) and dropped — aborting any in-flight copies — when this loop ends
/// (i.e. when the listener is aborted on forward removal or tunnel stop).
async fn run_listener(
    listener: TcpListener,
    handle: Arc<client::Handle<SshHandler>>,
    destination: Destination,
    pace: Pace,
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
                        pace,
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
    pace: Pace,
) {
    let conn = Accepted { tcp, peer, pace };
    match destination {
        Destination::Fixed { host, port } => forward_fixed(conn, &handle, host, port).await,
        Destination::Socks => forward_socks(conn, &handle).await,
    }
}

/// One accepted local connection, and how far its client may fall behind.
pub(super) struct Accepted {
    pub(super) tcp: TcpStream,
    pub(super) peer: SocketAddr,
    pub(super) pace: Pace,
}

impl Accepted {
    pub(super) async fn pump(self, channel: Channel<client::Msg>) {
        let _ = bridge(self.tcp, channel.into_stream(), self.pace).await;
    }
}

/// `ssh -L`: a channel-open failure drops the local connection (the DB client
/// sees a closed socket).
async fn forward_fixed(
    conn: Accepted,
    handle: &client::Handle<SshHandler>,
    host: String,
    port: u16,
) {
    if let Ok(channel) = open_direct_tcpip(handle, host, port, conn.peer).await {
        conn.pump(channel).await;
    }
}

pub(super) async fn open_direct_tcpip(
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tunnel::tests::forward_of;

    #[test]
    fn only_loopback_addresses_may_be_bound() {
        assert!(is_loopback("127.0.0.1"));
        assert!(is_loopback("127.4.5.6"));
        assert!(is_loopback("::1"));
        assert!(!is_loopback("0.0.0.0"));
        assert!(!is_loopback("192.168.1.10"));
        assert!(!is_loopback("localhost"));
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
}
