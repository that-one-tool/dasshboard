//! Bridges a forwarded connection's local socket and its SSH channel, draining
//! the channel ahead of a local client that reads slower than it delivers.
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

/// How far a forwarded connection's local client may fall behind, and how long
/// it may then stop reading before its connection is closed.
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
}

const CHUNK: usize = 32 * 1024;

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
        let ready = out.len().min(queue.bytes.len());
        for (slot, byte) in out.iter_mut().zip(queue.bytes.iter()) {
            *slot = *byte;
        }
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
