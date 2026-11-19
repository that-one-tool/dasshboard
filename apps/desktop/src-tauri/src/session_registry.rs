//! The live Sessions of every kind (SSH, serial, local shell): their ids, the
//! channels the commands talk to, and one lifecycle for every kind —
//! Connecting, then the kind's runner, then its final status or error, then
//! the entry is gone. A kind supplies only its runner.
//!
//! The map is a `std::sync::Mutex`, locked only to insert, remove or clone a
//! handle out; the guard is never held across an `.await`. A poisoned lock is
//! recovered: the map stays consistent whatever panicked while holding it.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tokio::sync::{mpsc, watch};

use crate::error::AppError;
use crate::session_sink::{SessionSink, SessionStatus};

/// Keeps the input channel bounded; keyboard-rate input never backs it up.
const INPUT_CHANNEL_CAPACITY: usize = 256;
/// How often, and how many times, `disconnect_all` checks the sessions ended.
const DRAIN_POLL_INTERVAL: Duration = Duration::from_millis(20);
const DRAIN_POLL_ATTEMPTS: usize = 50;

/// A Session about to start: its id and where it reports.
pub struct NewSession {
    pub id: String,
    pub sink: Arc<dyn SessionSink>,
}

/// A runner's end of its Session's channels. The size and `stop` go out of
/// band, so neither ever waits behind queued input.
pub struct RunnerControls {
    pub input: mpsc::Receiver<Vec<u8>>,
    pub resizes: Resizes,
    /// Turns true on a disconnect.
    pub stop: watch::Receiver<bool>,
}

/// The terminal size the pane last asked for, `(cols, rows)`: only the latest
/// counts.
pub struct Resizes(watch::Receiver<Option<(u32, u32)>>);

impl Resizes {
    /// The latest size asked for, if any.
    pub fn latest(&mut self) -> Option<(u32, u32)> {
        *self.0.borrow_and_update()
    }

    /// The next size asked for. Never resolves once the registry dropped the
    /// Session: its input closing ends the runner instead.
    pub async fn next(&mut self) -> (u32, u32) {
        loop {
            if self.0.changed().await.is_err() {
                std::future::pending::<()>().await;
            }
            if let Some(size) = self.latest() {
                return size;
            }
        }
    }
}

/// The commands' end of a Session's channels.
pub(crate) struct SessionHandle {
    pub(crate) input: mpsc::Sender<Vec<u8>>,
    pub(crate) size: watch::Sender<Option<(u32, u32)>>,
    pub(crate) stop: watch::Sender<bool>,
}

/// A fresh pair of channel ends, the registry's and its runner's.
pub(crate) fn open_channels() -> (SessionHandle, RunnerControls) {
    let (input_tx, input) = mpsc::channel(INPUT_CHANNEL_CAPACITY);
    let (size_tx, size) = watch::channel(None);
    let (stop_tx, stop) = watch::channel(false);
    let handle = SessionHandle {
        input: input_tx,
        size: size_tx,
        stop: stop_tx,
    };
    let resizes = Resizes(size);
    (
        handle,
        RunnerControls {
            input,
            resizes,
            stop,
        },
    )
}

/// A registered Session; `generation` tells it from a later one reusing its id.
struct Entry {
    generation: u64,
    handle: SessionHandle,
}

#[derive(Default)]
pub struct SessionRegistry {
    sessions: Mutex<HashMap<String, Entry>>,
    next_generation: AtomicU64,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start `session`. It is registered before this returns; the future `run`
    /// makes reports its final status, and is driven on its own task.
    pub fn spawn<F>(
        self: &Arc<Self>,
        session: NewSession,
        run: impl FnOnce(RunnerControls, Arc<dyn SessionSink>) -> F,
    ) where
        F: Future<Output = Result<SessionStatus, AppError>> + Send + 'static,
    {
        let (generation, controls) = self.register(&session.id);
        let runner = run(controls, Arc::clone(&session.sink));
        let task = SessionTask {
            registry: Arc::clone(self),
            session,
            generation,
            result: None,
        };
        tokio::spawn(task.drive(runner));
    }

    fn register(&self, id: &str) -> (u64, RunnerControls) {
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        let (handle, controls) = open_channels();
        let entry = Entry { generation, handle };
        self.lock_sessions().insert(id.to_string(), entry);
        (generation, controls)
    }

    /// Removes `id` only while it is still this `generation`'s entry.
    fn remove(&self, id: &str, generation: u64) {
        let mut sessions = self.lock_sessions();
        if sessions
            .get(id)
            .is_some_and(|entry| entry.generation == generation)
        {
            sessions.remove(id);
        }
    }

    fn lock_sessions(&self) -> MutexGuard<'_, HashMap<String, Entry>> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn owns(&self, id: &str) -> bool {
        self.lock_sessions().contains_key(id)
    }

    pub fn session_count(&self) -> usize {
        self.lock_sessions().len()
    }

    /// Unknown or ended Session ⇒ ignored.
    pub async fn write_stdin(&self, id: &str, data: Vec<u8>) {
        let Some(input) = self.input_of(id) else {
            return;
        };
        let _ = input.send(data).await;
    }

    /// Clones the sender out, so the lock is released before the send awaits.
    fn input_of(&self, id: &str) -> Option<mpsc::Sender<Vec<u8>>> {
        self.lock_sessions()
            .get(id)
            .map(|entry| entry.handle.input.clone())
    }

    /// Unknown or ended Session ⇒ ignored. Never waits: a newer size replaces
    /// one the runner has not applied yet.
    pub fn resize_pty(&self, id: &str, cols: u32, rows: u32) {
        self.with_handle(id, |handle| {
            handle.size.send_replace(Some((cols, rows)));
        });
    }

    /// Idempotent; an unknown id is a no-op. The Session's task removes its
    /// entry once its runner has ended.
    pub fn disconnect(&self, id: &str) {
        self.with_handle(id, |handle| {
            handle.stop.send_replace(true);
        });
    }

    fn with_handle(&self, id: &str, apply: impl FnOnce(&SessionHandle)) {
        if let Some(entry) = self.lock_sessions().get(id) {
            apply(&entry.handle);
        }
    }

    /// Disconnect every Session and wait, briefly, for them to end.
    pub async fn disconnect_all(&self) {
        let ids: Vec<String> = self.lock_sessions().keys().cloned().collect();
        for id in &ids {
            self.disconnect(id);
        }
        self.wait_until_drained().await;
    }

    async fn wait_until_drained(&self) {
        for _ in 0..DRAIN_POLL_ATTEMPTS {
            if self.session_count() == 0 {
                return;
            }
            tokio::time::sleep(DRAIN_POLL_INTERVAL).await;
        }
    }
}

/// One Session's task, the single owner of its cleanup. The end is reported
/// and the entry removed on drop, so a runner that panics (or a task dropped
/// at runtime shutdown) still frees its id.
///
/// A task dropped by runtime shutdown before its runner ended reports "the
/// session stopped unexpectedly". Acceptable: app close runs `disconnect_all`,
/// which drains Sessions first, and the Tauri runtime is never dropped while
/// the app runs.
struct SessionTask {
    registry: Arc<SessionRegistry>,
    session: NewSession,
    generation: u64,
    result: Option<Result<SessionStatus, AppError>>,
}

impl SessionTask {
    async fn drive(mut self, runner: impl Future<Output = Result<SessionStatus, AppError>>) {
        self.session.sink.on_status(SessionStatus::Connecting, None);
        self.result = Some(runner.await);
    }
}

impl Drop for SessionTask {
    fn drop(&mut self) {
        let sink = self.session.sink.as_ref();
        match self
            .result
            .take()
            .unwrap_or_else(|| Err(stopped_unexpectedly()))
        {
            Ok(status) => sink.on_status(status, None),
            Err(err) => sink.on_error(&err),
        }
        self.registry.remove(&self.session.id, self.generation);
    }
}

/// A runner that never returned: an error, not a plain drop, so the user sees
/// why; auto-reconnect's retry budget bounds a runner that keeps failing.
fn stopped_unexpectedly() -> AppError {
    AppError::Io("the session stopped unexpectedly".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_sink::testing::RecordingSink;
    use std::time::Instant;

    fn new_session(id: &str, sink: &Arc<RecordingSink>) -> NewSession {
        NewSession {
            id: id.to_string(),
            sink: Arc::clone(sink) as Arc<dyn SessionSink>,
        }
    }

    fn quiet_session(id: &str) -> NewSession {
        new_session(id, &Arc::new(RecordingSink::default()))
    }

    fn spawn_with(
        registry: &Arc<SessionRegistry>,
        id: &str,
        sink: &Arc<RecordingSink>,
        result: Result<SessionStatus, AppError>,
    ) {
        registry.spawn(
            new_session(id, sink),
            |_controls, _sink| async move { result },
        );
    }

    /// A runner that never reads its controls; they are handed back instead.
    fn spawn_idle(registry: &Arc<SessionRegistry>, id: &str) -> RunnerControls {
        let mut held = None;
        registry.spawn(quiet_session(id), |controls, _sink| {
            held = Some(controls);
            std::future::pending::<Result<SessionStatus, AppError>>()
        });
        held.expect("spawn builds the runner before returning")
    }

    /// A runner that records its input until it is stopped.
    fn spawn_recorder(registry: &Arc<SessionRegistry>, id: &str) -> Arc<Mutex<Vec<Vec<u8>>>> {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = Arc::clone(&seen);
        registry.spawn(quiet_session(id), |controls, _sink| async move {
            record_until_stopped(controls, &record).await;
            Ok(SessionStatus::Disconnected)
        });
        seen
    }

    async fn record_until_stopped(mut controls: RunnerControls, seen: &Mutex<Vec<Vec<u8>>>) {
        loop {
            tokio::select! {
                biased;
                bytes = controls.input.recv() => match bytes {
                    Some(bytes) => seen.lock().unwrap().push(bytes),
                    None => return,
                },
                _ = controls.stop.wait_for(|stopped| *stopped) => return,
            }
        }
    }

    async fn wait_until_gone(registry: &SessionRegistry, id: &str) {
        for _ in 0..100 {
            if !registry.owns(id) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("session {id} never ended");
    }

    #[tokio::test]
    async fn a_session_is_registered_before_spawn_returns() {
        let registry = Arc::new(SessionRegistry::new());
        spawn_recorder(&registry, "s1");

        assert!(registry.owns("s1"));
        assert_eq!(registry.session_count(), 1);
        registry.disconnect_all().await;
    }

    #[tokio::test]
    async fn connecting_comes_first_then_the_runners_status_then_the_entry_goes() {
        let registry = Arc::new(SessionRegistry::new());
        let sink = Arc::new(RecordingSink::default());
        spawn_with(&registry, "s1", &sink, Ok(SessionStatus::Exited));

        wait_until_gone(&registry, "s1").await;

        assert_eq!(
            sink.statuses(),
            [SessionStatus::Connecting, SessionStatus::Exited]
        );
    }

    #[tokio::test]
    async fn a_runner_error_is_reported_and_the_entry_goes() {
        let registry = Arc::new(SessionRegistry::new());
        let sink = Arc::new(RecordingSink::default());
        let error = AppError::Io("no such port".to_string());
        spawn_with(&registry, "s1", &sink, Err(error));

        wait_until_gone(&registry, "s1").await;

        assert_eq!(
            sink.statuses(),
            [SessionStatus::Connecting, SessionStatus::Error]
        );
        assert_eq!(registry.session_count(), 0);
    }

    #[tokio::test]
    async fn the_runner_gets_the_sessions_sink() {
        let registry = Arc::new(SessionRegistry::new());
        let sink = Arc::new(RecordingSink::default());
        registry.spawn(new_session("s1", &sink), |_controls, sink| async move {
            sink.on_data(b"hi");
            Ok(SessionStatus::Exited)
        });

        wait_until_gone(&registry, "s1").await;

        assert_eq!(sink.data(), b"hi");
    }

    #[tokio::test]
    async fn writes_reach_the_runner_in_order() {
        let registry = Arc::new(SessionRegistry::new());
        let seen = spawn_recorder(&registry, "s1");

        registry.write_stdin("s1", b"a".to_vec()).await;
        registry.write_stdin("s1", b"b".to_vec()).await;
        registry.disconnect("s1");
        wait_until_gone(&registry, "s1").await;

        assert_eq!(*seen.lock().unwrap(), [b"a".to_vec(), b"b".to_vec()]);
    }

    #[tokio::test]
    async fn a_resize_never_waits_behind_a_full_input_queue() {
        let registry = Arc::new(SessionRegistry::new());
        let mut controls = spawn_idle(&registry, "s1");
        for _ in 0..INPUT_CHANNEL_CAPACITY {
            registry.write_stdin("s1", b"x".to_vec()).await;
        }

        registry.resize_pty("s1", 100, 30);
        registry.resize_pty("s1", 120, 40);

        assert_eq!(controls.resizes.latest(), Some((120, 40)));
    }

    #[tokio::test]
    async fn the_runner_sees_only_the_latest_of_several_resizes() {
        let registry = Arc::new(SessionRegistry::new());
        let mut controls = spawn_idle(&registry, "s1");
        assert_eq!(controls.resizes.latest(), None);

        registry.resize_pty("s1", 100, 30);
        registry.resize_pty("s1", 132, 43);

        assert_eq!(controls.resizes.next().await, (132, 43));
        let none_pending = tokio::time::timeout(Duration::from_millis(20), controls.resizes.next());
        assert!(none_pending.await.is_err());
    }

    #[tokio::test]
    async fn resizes_wait_quietly_once_the_session_is_dropped() {
        let (handle, mut controls) = open_channels();
        drop(handle);

        let next = tokio::time::timeout(Duration::from_millis(20), controls.resizes.next());

        assert!(next.await.is_err());
    }

    #[tokio::test]
    async fn a_panicking_runner_reports_an_error_and_frees_its_id() {
        let registry = Arc::new(SessionRegistry::new());
        let sink = Arc::new(RecordingSink::default());
        registry.spawn(new_session("s1", &sink), |_controls, _sink| async {
            panic!("runner bug")
        });

        wait_until_gone(&registry, "s1").await;

        assert_eq!(
            sink.statuses(),
            [SessionStatus::Connecting, SessionStatus::Error]
        );
    }

    #[tokio::test]
    async fn an_ended_session_does_not_remove_a_newer_one_with_its_id() {
        let registry = Arc::new(SessionRegistry::new());
        let (end_first, first_ends) = tokio::sync::oneshot::channel::<()>();
        registry.spawn(quiet_session("s1"), |_controls, _sink| async {
            let _ = first_ends.await;
            Ok(SessionStatus::Disconnected)
        });
        let seen = spawn_recorder(&registry, "s1");

        end_first.send(()).unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        registry.write_stdin("s1", b"a".to_vec()).await;
        registry.disconnect("s1");
        wait_until_gone(&registry, "s1").await;

        assert_eq!(*seen.lock().unwrap(), [b"a".to_vec()]);
    }

    #[tokio::test]
    async fn a_disconnect_stops_only_its_own_session() {
        let registry = Arc::new(SessionRegistry::new());
        spawn_recorder(&registry, "s1");
        spawn_recorder(&registry, "s2");

        registry.disconnect("s1");
        wait_until_gone(&registry, "s1").await;

        assert!(registry.owns("s2"));
        registry.disconnect_all().await;
    }

    #[tokio::test]
    async fn an_unknown_id_is_ignored() {
        let registry = Arc::new(SessionRegistry::new());

        registry.write_stdin("nope", b"x".to_vec()).await;
        registry.resize_pty("nope", 80, 24);
        registry.disconnect("nope");

        assert!(!registry.owns("nope"));
    }

    #[tokio::test]
    async fn disconnect_all_ends_every_session() {
        let registry = Arc::new(SessionRegistry::new());
        spawn_recorder(&registry, "s1");
        spawn_recorder(&registry, "s2");

        registry.disconnect_all().await;

        assert_eq!(registry.session_count(), 0);
    }

    #[tokio::test]
    async fn disconnect_all_gives_up_on_a_session_that_never_ends() {
        let registry = Arc::new(SessionRegistry::new());
        registry.spawn(quiet_session("stuck"), |_controls, _sink| async {
            std::future::pending::<Result<SessionStatus, AppError>>().await
        });
        let started = Instant::now();

        registry.disconnect_all().await;

        assert!(started.elapsed() < Duration::from_secs(3));
        assert!(registry.owns("stuck"));
    }
}
