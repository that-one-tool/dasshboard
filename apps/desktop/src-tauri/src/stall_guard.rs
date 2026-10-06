//! The local end of a forwarded connection, which gives up on a peer that
//! stops reading.
//!
//! russh hands a channel's data to its reader with a blocking send from the
//! connection's single loop, and re-opens the window as soon as data arrives,
//! not when it is read. A local client that stops reading therefore stops its
//! pump draining the channel, and once the channel's buffer is full the whole
//! SSH connection stops: every other forward on the tunnel, and the jump host
//! carrying it. Failing a write that makes no progress for a while ends only
//! that connection, which drops its channel and lets russh's loop run again.
//!
//! Known limit: a peer that keeps reading, only slowly, never trips this, so
//! the whole connection still moves at its pace. Fixing that would mean
//! draining every channel into a capped buffer and closing a connection that
//! overflows it, which would cut off a large transfer to a slow consumer.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::time::Sleep;

/// How long a forwarded connection's local peer may stop reading before the
/// connection is closed. Long enough for a client that briefly pauses; while
/// it lasts, the tunnel's other connections wait too.
pub(crate) const STALL_TIMEOUT: Duration = Duration::from_secs(20);

/// Wraps a stream so a write (or flush/shutdown) that stays pending for
/// `limit` fails with [`io::ErrorKind::TimedOut`]. Any progress restarts the
/// clock; reads pass through untouched.
pub(crate) struct StallGuard<S> {
    inner: S,
    limit: Duration,
    stalled: Option<Pin<Box<Sleep>>>,
}

impl<S> StallGuard<S> {
    pub(crate) fn new(inner: S, limit: Duration) -> Self {
        StallGuard {
            inner,
            limit,
            stalled: None,
        }
    }

    /// Pass a ready result through (and reset the clock), or keep waiting
    /// until the stall has lasted `limit`.
    fn watch<T>(
        &mut self,
        cx: &mut Context<'_>,
        polled: Poll<io::Result<T>>,
    ) -> Poll<io::Result<T>> {
        if polled.is_ready() {
            self.stalled = None;
            return polled;
        }
        let limit = self.limit;
        let timer = self
            .stalled
            .get_or_insert_with(|| Box::pin(tokio::time::sleep(limit)));
        match timer.as_mut().poll(cx) {
            Poll::Ready(()) => Poll::Ready(Err(io::ErrorKind::TimedOut.into())),
            Poll::Pending => Poll::Pending,
        }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for StallGuard<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for StallGuard<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let polled = Pin::new(&mut this.inner).poll_write(cx, buf);
        this.watch(cx, polled)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let polled = Pin::new(&mut this.inner).poll_flush(cx);
        this.watch(cx, polled)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let polled = Pin::new(&mut this.inner).poll_shutdown(cx);
        this.watch(cx, polled)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const LIMIT: Duration = Duration::from_millis(100);

    #[tokio::test]
    async fn a_write_the_peer_never_reads_times_out() {
        let (ours, _peer) = tokio::io::duplex(64);
        let mut guarded = StallGuard::new(ours, LIMIT);

        let written = tokio::time::timeout(Duration::from_secs(5), guarded.write_all(&[0; 1024]))
            .await
            .expect("the stall must end the write");

        assert_eq!(written.unwrap_err().kind(), io::ErrorKind::TimedOut);
    }

    #[tokio::test]
    async fn a_slow_reader_that_keeps_reading_never_times_out() {
        let (ours, mut peer) = tokio::io::duplex(64);
        let mut guarded = StallGuard::new(ours, LIMIT);
        // Takes ~16 × 40 ms in all, well past the limit: only progress resets it.
        let reader = tokio::spawn(async move {
            let mut total = 0;
            let mut chunk = [0; 64];
            while total < 1024 {
                tokio::time::sleep(Duration::from_millis(40)).await;
                total += peer.read(&mut chunk).await.unwrap();
            }
        });

        guarded
            .write_all(&[0; 1024])
            .await
            .expect("a reading peer never stalls");
        reader.await.unwrap();
    }

    #[tokio::test]
    async fn reads_pass_through() {
        let (ours, mut peer) = tokio::io::duplex(64);
        let mut guarded = StallGuard::new(ours, LIMIT);
        peer.write_all(b"ping").await.unwrap();

        let mut buf = [0; 4];
        guarded.read_exact(&mut buf).await.unwrap();

        assert_eq!(&buf, b"ping");
    }
}
