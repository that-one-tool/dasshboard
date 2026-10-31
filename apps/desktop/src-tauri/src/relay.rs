//! Bridges a local stream (a forwarded connection's socket, or the target
//! connection riding a jump host) and its SSH channel, draining the channel
//! ahead of a local side that reads slower than it delivers.
//!
//! russh hands a channel's data to its reader with a blocking send from the
//! connection's single loop, and re-opens the window as soon as data arrives,
//! not when it is read. A channel nobody drains therefore stops the whole SSH
//! connection: every other forward of the tunnel, and the jump host carrying
//! it. So the channel is read into a per-connection backlog that the local
//! socket is fed from at its own pace: a client that pauses doesn't hold up
//! the others. Past [`Pace::backlog`] the channel is no longer read (there is
//! no per-channel flow control to slow the server down instead), so a client
//! far behind sets the whole connection's pace again; one that makes no
//! progress at all for [`Pace::stall`] meanwhile has its connection closed.

use std::collections::VecDeque;
use std::io;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Notify;

/// How far the local side may fall behind, and how long it may then stop
/// reading before its connection is closed.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Pace {
    pub(crate) backlog: usize,
    pub(crate) stall: Duration,
}

impl Pace {
    pub(crate) const DEFAULT: Pace = Pace {
        backlog: 8 << 20,
        stall: Duration::from_secs(20),
    };

    /// Never stops reading the channel, so never cuts the client either.
    pub(crate) const UNLIMITED: Pace = Pace {
        backlog: usize::MAX,
        stall: Duration::MAX,
    };
}

const CHUNK: usize = 32 * 1024;

/// How long a bridge whose local side ended waits for the remote to close.
const REMOTE_CLOSE_GRACE: Duration = Duration::from_millis(200);

/// Copy both ways between `local` and `remote` until both sides are done,
/// buffering `remote`'s data for `local` as `pace` allows.
pub(crate) async fn bridge<L, R>(local: L, remote: R, pace: Pace) -> io::Result<()>
where
    L: AsyncRead + AsyncWrite + Unpin,
    R: AsyncRead + AsyncWrite + Unpin,
{
    let (local_rd, local_wr) = tokio::io::split(local);
    let (remote_rd, remote_wr) = tokio::io::split(remote);
    tokio::try_join!(
        relay(remote_rd, local_wr, pace),
        upload(local_rd, remote_wr)
    )?;
    Ok(())
}

/// Like [`bridge`], but done as soon as either side ends, dropping both: for
/// a stream neither side half-closes (SSH over a channel), where waiting on
/// the other side could hold it open for good.
pub(crate) async fn bridge_until_either_ends<L, R>(
    local: L,
    remote: R,
    pace: Pace,
) -> io::Result<()>
where
    L: AsyncRead + AsyncWrite + Unpin,
    R: AsyncRead + AsyncWrite + Unpin,
{
    let (local_rd, local_wr) = tokio::io::split(local);
    let (mut remote_rd, remote_wr) = tokio::io::split(remote);
    let uploading = upload(local_rd, remote_wr);
    tokio::pin!(uploading);
    let uploaded = tokio::select! {
        delivered = relay(&mut remote_rd, local_wr, pace) => match delivered {
            // The local side closed under the delivery: what it sent last is
            // still on its way out.
            Err(error) if error.kind() == io::ErrorKind::BrokenPipe => uploading.await,
            other => return other,
        },
        uploaded = &mut uploading => uploaded,
    };
    // Dropping the remote with its data unread resets its far end, which can
    // then lose what the local side sent last: let the far end close first.
    let mut discard = tokio::io::sink();
    let draining = tokio::io::copy(&mut remote_rd, &mut discard);
    let _ = tokio::time::timeout(REMOTE_CLOSE_GRACE, draining).await;
    uploaded
}

async fn upload<R, W>(mut from: R, mut to: W) -> io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    tokio::io::copy(&mut from, &mut to).await?;
    to.shutdown().await
}

/// Copy `from` into `to`, reading `from` ahead of `to` by up to the backlog.
async fn relay<R, W>(mut from: R, mut to: W, pace: Pace) -> io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let backlog = &Backlog::default();
    let drain = async move {
        let mut buf = vec![0u8; CHUNK];
        loop {
            backlog.wait_for_room(pace).await?;
            let read = from.read(&mut buf).await?;
            if read == 0 {
                backlog.finish();
                return Ok(());
            }
            backlog.push(&buf[..read]);
        }
    };
    let deliver = async move {
        let mut out = vec![0u8; CHUNK];
        loop {
            let ready = backlog.peek(&mut out).await;
            if ready == 0 {
                return to.shutdown().await;
            }
            let written = to.write(&out[..ready]).await?;
            backlog.consume(written);
        }
    };
    tokio::try_join!(drain, deliver)?;
    Ok(())
}

/// The bytes read from the channel that the local client hasn't taken yet.
#[derive(Default)]
struct Backlog {
    queue: Mutex<Queue>,
    /// Bytes (or the end) arrived.
    filled: Notify,
    /// The client took some bytes.
    taken: Notify,
}

#[derive(Default)]
struct Queue {
    bytes: VecDeque<u8>,
    finished: bool,
}

impl Backlog {
    fn push(&self, bytes: &[u8]) {
        self.lock().bytes.extend(bytes);
        self.filled.notify_waiters();
    }

    /// The channel ended: once the client took the rest, it ends too.
    fn finish(&self) {
        self.lock().finished = true;
        self.filled.notify_waiters();
    }

    /// Copy the next bytes into `out` (left queued until `consume`d); `0` once
    /// the channel ended and all was taken.
    async fn peek(&self, out: &mut [u8]) -> usize {
        loop {
            let filled = self.filled.notified();
            tokio::pin!(filled);
            filled.as_mut().enable();
            if let Some(ready) = self.copy_front(out) {
                return ready;
            }
            filled.await;
        }
    }

    fn copy_front(&self, out: &mut [u8]) -> Option<usize> {
        let queue = self.lock();
        let (front, back) = queue.bytes.as_slices();
        let from_front = out.len().min(front.len());
        let from_back = (out.len() - from_front).min(back.len());
        out[..from_front].copy_from_slice(&front[..from_front]);
        out[from_front..from_front + from_back].copy_from_slice(&back[..from_back]);
        let ready = from_front + from_back;
        (ready > 0 || queue.finished).then_some(ready)
    }

    fn consume(&self, count: usize) {
        self.lock().bytes.drain(..count);
        self.taken.notify_waiters();
    }

    /// Wait until the backlog is under the limit; fails once the client made
    /// no progress for `pace.stall` meanwhile.
    async fn wait_for_room(&self, pace: Pace) -> io::Result<()> {
        loop {
            let taken = self.taken.notified();
            tokio::pin!(taken);
            taken.as_mut().enable();
            if self.lock().bytes.len() < pace.backlog {
                return Ok(());
            }
            if tokio::time::timeout(pace.stall, taken).await.is_err() {
                return Err(io::Error::other("the local client stopped reading"));
            }
        }
    }

    fn lock(&self) -> MutexGuard<'_, Queue> {
        self.queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WAIT: Duration = Duration::from_secs(5);

    fn pace(backlog: usize, stall: Duration) -> Pace {
        Pace { backlog, stall }
    }

    const ROOMY: Pace = Pace {
        backlog: 1 << 20,
        stall: Duration::from_secs(20),
    };

    #[tokio::test]
    async fn relays_everything_then_ends_the_destination() {
        let (mut source, src) = tokio::io::duplex(64);
        let (dst, mut sink) = tokio::io::duplex(64);
        let relaying = tokio::spawn(relay(src, dst, ROOMY));

        source.write_all(b"hello, ").await.unwrap();
        source.write_all(b"world").await.unwrap();
        drop(source);
        let mut got = Vec::new();
        tokio::time::timeout(WAIT, sink.read_to_end(&mut got))
            .await
            .unwrap()
            .unwrap();

        assert_eq!(got, b"hello, world");
        relaying.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn the_source_keeps_draining_while_the_destination_pauses() {
        let (mut source, src) = tokio::io::duplex(64);
        let (dst, mut sink) = tokio::io::duplex(64);
        tokio::spawn(relay(src, dst, ROOMY));

        // Far more than the pipes hold: only a draining relay takes it all.
        tokio::time::timeout(WAIT, source.write_all(&[7; 256 * 1024]))
            .await
            .expect("the source must not wait on the paused destination")
            .unwrap();
        drop(source);
        let mut got = Vec::new();
        sink.read_to_end(&mut got).await.unwrap();
        assert_eq!(got.len(), 256 * 1024);
    }

    #[tokio::test]
    async fn past_the_backlog_limit_the_source_waits_for_the_destination() {
        let (mut source, src) = tokio::io::duplex(64);
        let (dst, _sink) = tokio::io::duplex(64);
        tokio::spawn(relay(src, dst, pace(4096, Duration::from_secs(20))));

        let flooded = tokio::time::timeout(
            Duration::from_millis(500),
            source.write_all(&[7; 64 * 1024]),
        )
        .await;

        assert!(flooded.is_err(), "the relay must stop reading at the limit");
    }

    #[tokio::test]
    async fn a_slow_destination_past_the_limit_is_kept_while_it_reads() {
        const TOTAL: usize = 32 * 1024;
        let (mut source, src) = tokio::io::duplex(64);
        let (dst, mut sink) = tokio::io::duplex(512);
        let relaying = tokio::spawn(relay(src, dst, pace(4096, Duration::from_millis(300))));
        tokio::spawn(async move { source.write_all(&[7; TOTAL]).await });

        // ~50 KB/s: far slower than the source, yet never stalled for 300 ms.
        let mut got = 0;
        let mut buf = [0; 512];
        while got < TOTAL {
            tokio::time::sleep(Duration::from_millis(10)).await;
            got += sink.read(&mut buf).await.unwrap();
        }

        assert_eq!(got, TOTAL);
        let ended = tokio::time::timeout(WAIT, relaying).await.unwrap().unwrap();
        assert!(ended.is_ok(), "the slow reader must not be cut off");
    }

    #[tokio::test]
    async fn a_destination_stalled_past_the_limit_ends_the_relay() {
        let (mut source, src) = tokio::io::duplex(64);
        let (dst, _sink) = tokio::io::duplex(64);
        let relaying = tokio::spawn(relay(src, dst, pace(4096, Duration::from_millis(100))));
        tokio::spawn(async move { source.write_all(&[7; 64 * 1024]).await });

        let ended = tokio::time::timeout(WAIT, relaying).await.unwrap().unwrap();
        assert!(ended.is_err());
    }

    #[tokio::test]
    async fn an_unlimited_pace_keeps_draining_a_paused_destination() {
        let (mut source, src) = tokio::io::duplex(64);
        let (dst, _sink) = tokio::io::duplex(64);
        tokio::spawn(relay(src, dst, Pace::UNLIMITED));

        tokio::time::timeout(WAIT, source.write_all(&vec![7; 2 * Pace::DEFAULT.backlog]))
            .await
            .expect("an unlimited relay must never stop reading")
            .unwrap();
    }

    #[tokio::test]
    async fn bridge_until_either_ends_ends_with_the_remote() {
        let (_client, local) = tokio::io::duplex(64);
        let (remote, server) = tokio::io::duplex(64);
        let bridging = tokio::spawn(bridge_until_either_ends(local, remote, ROOMY));

        drop(server);

        let ended = tokio::time::timeout(WAIT, bridging).await;
        assert!(ended.is_ok(), "a silent local side must not keep it alive");
    }

    #[tokio::test]
    async fn bridge_until_either_ends_ends_with_the_local() {
        let (client, local) = tokio::io::duplex(64);
        let (remote, _server) = tokio::io::duplex(64);
        let bridging = tokio::spawn(bridge_until_either_ends(local, remote, ROOMY));

        drop(client);

        let ended = tokio::time::timeout(WAIT, bridging).await;
        assert!(ended.is_ok(), "a silent remote must not keep it alive");
    }

    #[tokio::test]
    async fn bridge_until_either_ends_delivers_what_the_remote_sent_last() {
        let (mut client, local) = tokio::io::duplex(64);
        let (remote, mut server) = tokio::io::duplex(64);
        tokio::spawn(bridge_until_either_ends(local, remote, ROOMY));

        server.write_all(b"bye").await.unwrap();
        drop(server);

        let mut got = Vec::new();
        tokio::time::timeout(WAIT, client.read_to_end(&mut got))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(got, b"bye");
    }

    #[tokio::test]
    async fn bridge_until_either_ends_forwards_the_last_words_of_a_local_closing_mid_delivery() {
        for _ in 0..50 {
            let (mut client, local) = tokio::io::duplex(64);
            let (remote, mut server) = tokio::io::duplex(64);
            tokio::spawn(bridge_until_either_ends(local, remote, ROOMY));
            server.write_all(&[7; 4096]).await.unwrap();

            client.write_all(b"bye").await.unwrap();
            drop(client);

            let mut got = Vec::new();
            tokio::time::timeout(WAIT, server.read_to_end(&mut got))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                got, b"bye",
                "what the local side sent last must get through"
            );
        }
    }

    #[test]
    fn the_backlog_hands_out_its_front_in_order_across_pushes() {
        let backlog = Backlog::default();
        let mut out = [0u8; 4];
        backlog.push(b"abcdef");
        backlog.consume(5);
        backlog.push(b"ghijkl");

        assert_eq!(backlog.copy_front(&mut out), Some(4));
        assert_eq!(&out, b"fghi");
        backlog.consume(4);
        assert_eq!(backlog.copy_front(&mut out), Some(3));
        assert_eq!(&out[..3], b"jkl");
    }

    #[tokio::test]
    async fn bridge_copies_both_ways() {
        let (mut client, local) = tokio::io::duplex(64);
        let (remote, mut server) = tokio::io::duplex(64);
        let bridging = tokio::spawn(bridge(local, remote, ROOMY));

        client.write_all(b"ping").await.unwrap();
        let mut up = [0; 4];
        server.read_exact(&mut up).await.unwrap();
        server.write_all(b"pong").await.unwrap();
        let mut down = [0; 4];
        client.read_exact(&mut down).await.unwrap();
        drop(client);
        drop(server);

        assert_eq!((&up, &down), (b"ping", b"pong"));
        tokio::time::timeout(WAIT, bridging)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}
