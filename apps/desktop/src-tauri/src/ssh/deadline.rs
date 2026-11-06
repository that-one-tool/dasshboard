//! The overall connect deadline (B3), stopped while the user answers a
//! prompt: a host that stalls is cut off, a user still typing a code is not
//! (each prompt has its own timeout).

use std::pin::pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tokio::sync::Notify;
use tokio::time::Instant;

pub(crate) struct ConnectDeadline {
    clock: Mutex<Clock>,
    changed: Notify,
}

struct Clock {
    budget_left: Duration,
    /// When the budget last started running; `None` while paused.
    running_since: Option<Instant>,
    pauses: usize,
}

/// Holds the deadline still until dropped.
pub(crate) struct DeadlinePause(Arc<ConnectDeadline>);

impl Drop for DeadlinePause {
    fn drop(&mut self) {
        self.0.resume();
    }
}

impl ConnectDeadline {
    pub(crate) fn new(budget: Duration) -> Arc<Self> {
        Arc::new(ConnectDeadline {
            clock: Mutex::new(Clock {
                budget_left: budget,
                running_since: Some(Instant::now()),
                pauses: 0,
            }),
            changed: Notify::new(),
        })
    }

    pub(crate) fn pause(self: &Arc<Self>) -> DeadlinePause {
        let mut clock = self.lock();
        if let Some(since) = clock.running_since.take() {
            clock.budget_left = clock.budget_left.saturating_sub(since.elapsed());
        }
        clock.pauses += 1;
        drop(clock);
        self.changed.notify_waiters();
        DeadlinePause(Arc::clone(self))
    }

    fn resume(&self) {
        let mut clock = self.lock();
        clock.pauses -= 1;
        if clock.pauses == 0 {
            clock.running_since = Some(Instant::now());
        }
        drop(clock);
        self.changed.notify_waiters();
    }

    /// Resolves once the budget ran out (never while paused).
    pub(crate) async fn expired(&self) {
        loop {
            let mut changed = pin!(self.changed.notified());
            changed.as_mut().enable();
            let Some(ends_at) = self.ends_at() else {
                changed.await;
                continue;
            };
            tokio::select! {
                _ = tokio::time::sleep_until(ends_at) => return,
                _ = changed => {}
            }
        }
    }

    /// When the running budget ends; `None` while paused.
    fn ends_at(&self) -> Option<Instant> {
        let clock = self.lock();
        clock.running_since.map(|since| since + clock.budget_left)
    }

    fn lock(&self) -> MutexGuard<'_, Clock> {
        self.clock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUDGET: Duration = Duration::from_millis(150);

    async fn expires_within(deadline: &ConnectDeadline, limit: Duration) -> bool {
        tokio::time::timeout(limit, deadline.expired())
            .await
            .is_ok()
    }

    #[tokio::test]
    async fn an_untouched_deadline_expires_after_its_budget() {
        let deadline = ConnectDeadline::new(BUDGET);
        assert!(!expires_within(&deadline, BUDGET / 2).await);
        assert!(expires_within(&deadline, BUDGET).await);
    }

    #[tokio::test]
    async fn time_spent_paused_is_not_counted() {
        let deadline = ConnectDeadline::new(BUDGET);
        let pause = deadline.pause();
        assert!(!expires_within(&deadline, BUDGET * 2).await);
        drop(pause);
        assert!(!expires_within(&deadline, BUDGET / 2).await);
        assert!(expires_within(&deadline, BUDGET).await);
    }

    #[tokio::test]
    async fn the_clock_runs_again_only_once_every_pause_ended() {
        let deadline = ConnectDeadline::new(BUDGET);
        let host_key = deadline.pause();
        let auth = deadline.pause();
        drop(host_key);
        assert!(!expires_within(&deadline, BUDGET * 2).await);
        drop(auth);
        assert!(expires_within(&deadline, BUDGET * 2).await);
    }

    #[tokio::test]
    async fn a_pause_taken_while_waiting_stops_the_wait() {
        let deadline = ConnectDeadline::new(BUDGET);
        let waiter = {
            let deadline = Arc::clone(&deadline);
            tokio::spawn(async move { deadline.expired().await })
        };
        tokio::time::sleep(BUDGET / 3).await;
        let _pause = deadline.pause();
        tokio::time::sleep(BUDGET * 2).await;
        assert!(!waiter.is_finished(), "a paused deadline never expires");
        waiter.abort();
    }
}
