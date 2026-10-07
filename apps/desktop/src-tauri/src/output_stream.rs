//! A terminal session's output, kept until the frontend has fetched it.
//!
//! Output used to be pushed over a Tauri `Channel`, whose JS side delivers
//! strictly in order: one message lost on the way (a failed IPC fetch, retried
//! after Rust had already handed the data out) held back every later one, and
//! the terminal froze for good while the session itself was fine. Instead the
//! frontend pulls: `read_output(from)` returns what follows offset `from`, and
//! only a later read past it lets those bytes go, so a lost or retried read
//! simply reads them again.
//!
//! A frontend that stops reading (a suspended webview) can't make the backlog
//! grow forever: past `limit` the oldest unread bytes are dropped, and the next
//! read starts after them.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tokio::sync::Notify;

/// The most unread output a session keeps: what xterm.js itself would buffer
/// before discarding (its write buffer's 50 MB watermark), so output that
/// comes faster than the terminal parses it is not lost any earlier than it
/// was with the push channel.
pub(crate) const OUTPUT_LIMIT: usize = 50_000_000;
/// The most one read returns.
pub(crate) const MAX_READ: usize = 256 * 1024;
/// How long a read waits for output before returning empty, so a reader whose
/// session is gone without a word never waits forever.
pub(crate) const READ_WAIT: Duration = Duration::from_secs(15);

/// What one read returns: `bytes` from offset `start` on (`start` is past the
/// requested offset only when unread output was dropped), and `end` once the
/// session is over and everything was read.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Chunk {
    pub(crate) start: u64,
    pub(crate) bytes: Vec<u8>,
    pub(crate) end: bool,
}

impl Chunk {
    /// The wire form: `start` (8 bytes, big-endian), `end` (1 byte), the bytes.
    pub(crate) fn encode(&self) -> Vec<u8> {
        let mut wire = Vec::with_capacity(9 + self.bytes.len());
        wire.extend_from_slice(&self.start.to_be_bytes());
        wire.push(u8::from(self.end));
        wire.extend_from_slice(&self.bytes);
        wire
    }
}

#[derive(Default)]
struct Pending {
    /// Unread output; its first byte is at offset `start`.
    buf: VecDeque<u8>,
    start: u64,
    closed: bool,
}

impl Pending {
    /// Drop the first `count` bytes (at most all of them).
    fn drop_front(&mut self, count: usize) {
        let count = count.min(self.buf.len());
        self.buf.drain(..count);
        self.start += count as u64;
    }

    /// Let go of the output before `from`, and return what follows, or `None`
    /// while there is nothing yet.
    fn take(&mut self, from: u64, max: usize) -> Option<Chunk> {
        let read = usize::try_from(from.saturating_sub(self.start)).unwrap_or(usize::MAX);
        self.drop_front(read);
        let bytes: Vec<u8> = self.buf.iter().take(max).copied().collect();
        let end = bytes.is_empty() && self.closed;
        (!bytes.is_empty() || end).then_some(Chunk {
            start: self.start,
            bytes,
            end,
        })
    }
}

pub(crate) struct OutputStream {
    pending: Mutex<Pending>,
    arrived: Notify,
    limit: usize,
}

impl OutputStream {
    pub(crate) fn new(limit: usize) -> Self {
        OutputStream {
            pending: Mutex::default(),
            arrived: Notify::new(),
            limit,
        }
    }

    /// Append the session's output.
    pub(crate) fn push(&self, bytes: &[u8]) {
        let mut pending = self.lock();
        pending.buf.extend(bytes);
        let over = pending.buf.len().saturating_sub(self.limit);
        pending.drop_front(over);
        drop(pending);
        self.arrived.notify_waiters();
    }

    /// The session is over: once its output is read, reads report the end.
    pub(crate) fn close(&self) {
        self.lock().closed = true;
        self.arrived.notify_waiters();
    }

    /// Let go of the output before `from`, then return what follows (up to
    /// `max` bytes), waiting up to `wait` for some.
    pub(crate) async fn read(&self, from: u64, max: usize, wait: Duration) -> Chunk {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            // Registered before looking, so output pushed in between still wakes it.
            let arrived = self.arrived.notified();
            tokio::pin!(arrived);
            arrived.as_mut().enable();
            if let Some(chunk) = self.lock().take(from, max) {
                return chunk;
            }
            if tokio::time::timeout_at(deadline, arrived).await.is_err() {
                return self.nothing_after(from);
            }
        }
    }

    /// An empty read at `from` (or past it, if unread output was dropped).
    fn nothing_after(&self, from: u64) -> Chunk {
        Chunk {
            start: from.max(self.lock().start),
            bytes: Vec::new(),
            end: false,
        }
    }

    fn lock(&self) -> MutexGuard<'_, Pending> {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// The live sessions' output streams, by session id.
#[derive(Default)]
pub struct OutputStreams(Mutex<HashMap<String, Arc<OutputStream>>>);

impl OutputStreams {
    /// A new, empty stream for session `id`.
    pub(crate) fn open(&self, id: &str) -> Arc<OutputStream> {
        let stream = Arc::new(OutputStream::new(OUTPUT_LIMIT));
        self.lock().insert(id.to_string(), Arc::clone(&stream));
        stream
    }

    pub(crate) fn get(&self, id: &str) -> Option<Arc<OutputStream>> {
        self.lock().get(id).cloned()
    }

    pub(crate) fn contains(&self, id: &str) -> bool {
        self.lock().contains_key(id)
    }

    /// Forget session `id`'s stream, unless it was replaced by another.
    pub(crate) fn remove(&self, id: &str, stream: &Arc<OutputStream>) {
        let mut streams = self.lock();
        if streams.get(id).is_some_and(|s| Arc::ptr_eq(s, stream)) {
            streams.remove(id);
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, Arc<OutputStream>>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: Duration = Duration::ZERO;

    fn chunk(start: u64, bytes: &[u8], end: bool) -> Chunk {
        Chunk {
            start,
            bytes: bytes.to_vec(),
            end,
        }
    }

    #[tokio::test]
    async fn reads_output_in_order() {
        let out = OutputStream::new(1024);
        out.push(b"hello ");
        out.push(b"world");
        assert_eq!(out.read(0, 64, NOW).await, chunk(0, b"hello world", false));
        assert_eq!(out.read(11, 64, NOW).await, chunk(11, b"", false));
    }

    #[tokio::test]
    async fn a_read_repeated_from_the_same_offset_gets_the_same_bytes() {
        let out = OutputStream::new(1024);
        out.push(b"abc");
        let first = out.read(0, 64, NOW).await;
        // The reply was lost: the frontend asks again from where it was.
        assert_eq!(out.read(0, 64, NOW).await, first);
        out.push(b"def");
        assert_eq!(out.read(3, 64, NOW).await, chunk(3, b"def", false));
    }

    #[tokio::test]
    async fn a_read_returns_at_most_max_bytes() {
        let out = OutputStream::new(1024);
        out.push(b"abcdef");
        assert_eq!(out.read(0, 4, NOW).await, chunk(0, b"abcd", false));
        assert_eq!(out.read(4, 4, NOW).await, chunk(4, b"ef", false));
    }

    #[tokio::test]
    async fn a_read_waits_for_output() {
        let out = Arc::new(OutputStream::new(1024));
        let reader = tokio::spawn({
            let out = Arc::clone(&out);
            async move { out.read(0, 64, Duration::from_secs(5)).await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        out.push(b"late");
        assert_eq!(reader.await.unwrap(), chunk(0, b"late", false));
    }

    #[tokio::test]
    async fn a_read_gives_up_waiting_with_nothing() {
        let out = OutputStream::new(1024);
        let read = out.read(0, 64, Duration::from_millis(20)).await;
        assert_eq!(read, chunk(0, b"", false));
    }

    #[tokio::test]
    async fn the_end_comes_after_the_last_output() {
        let out = OutputStream::new(1024);
        out.push(b"bye");
        out.close();
        assert_eq!(out.read(0, 64, NOW).await, chunk(0, b"bye", false));
        assert_eq!(out.read(3, 64, NOW).await, chunk(3, b"", true));
    }

    #[tokio::test]
    async fn closing_wakes_a_waiting_read() {
        let out = Arc::new(OutputStream::new(1024));
        let reader = tokio::spawn({
            let out = Arc::clone(&out);
            async move { out.read(0, 64, Duration::from_secs(5)).await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        out.close();
        assert_eq!(reader.await.unwrap(), chunk(0, b"", true));
    }

    #[tokio::test]
    async fn unread_output_past_the_limit_drops_the_oldest() {
        let out = OutputStream::new(4);
        out.push(b"abcdef");
        assert_eq!(out.read(0, 64, NOW).await, chunk(2, b"cdef", false));
    }

    #[test]
    fn a_chunk_encodes_its_start_end_flag_and_bytes() {
        let wire = chunk(0x0102, b"hi", true).encode();
        assert_eq!(wire, [0, 0, 0, 0, 0, 0, 1, 2, 1, b'h', b'i']);
        assert_eq!(chunk(0, b"", false).encode(), [0; 9]);
    }

    #[test]
    fn streams_are_kept_by_session_until_removed() {
        let streams = OutputStreams::default();
        let stream = streams.open("s1");
        assert!(streams.contains("s1"));
        assert!(Arc::ptr_eq(&streams.get("s1").unwrap(), &stream));
        streams.remove("s1", &stream);
        assert!(streams.get("s1").is_none());
    }

    #[test]
    fn removing_a_replaced_stream_keeps_its_successor() {
        let streams = OutputStreams::default();
        let old = streams.open("s1");
        let new = streams.open("s1");
        streams.remove("s1", &old);
        assert!(Arc::ptr_eq(&streams.get("s1").unwrap(), &new));
    }
}
