//! Dynamic forwards (`ssh -D`): a SOCKS handshake names each connection's
//! target.

use std::time::Duration;

use russh::{client, ChannelOpenFailure};
use tokio::io::{AsyncRead, AsyncWrite};

use super::local::{open_direct_tcpip, Accepted};
use crate::socks;
use crate::ssh::handler::SshHandler;

/// How long a SOCKS client gets to send its request before its connection is
/// dropped, so an idle or non-SOCKS client can't hold a task forever.
const SOCKS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// `ssh -D`: learn the target from the SOCKS request, open the channel, and
/// tell the client whether it worked before pumping.
pub(super) async fn forward_socks(mut conn: Accepted, handle: &client::Handle<SshHandler>) {
    let Some(request) = socks_handshake(&mut conn.tcp, SOCKS_HANDSHAKE_TIMEOUT).await else {
        return;
    };
    let opened = open_direct_tcpip(handle, request.host, request.port, conn.peer).await;
    let _ = socks::reply(&mut conn.tcp, request.version, socks_outcome(&opened)).await;
    match opened {
        Ok(channel) => conn.pump(channel).await,
        Err(_) => socks::close(&mut conn.tcp).await,
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
