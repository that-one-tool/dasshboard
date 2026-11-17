//! The in-memory value of a JSON store. A write edits a copy, persists it
//! without holding the value's lock, and swaps it in once stored, so a reader
//! (often on the UI thread) never waits for a disk write. Writes take turns:
//! each one starts from the value the one before it stored, and the file ends
//! with the value the last one stored.

use std::sync::{Mutex, MutexGuard};

use crate::atomic_file::lock;

pub struct StoreCell<T> {
    value: Mutex<T>,
    writes: Mutex<()>,
}

/// A write's exclusive turn. Dropping it without [`commit`](Self::commit)
/// leaves the value as it was (a failed persist).
pub struct WriteTurn<'a, T> {
    cell: &'a StoreCell<T>,
    _turn: MutexGuard<'a, ()>,
}

impl<T: Clone> StoreCell<T> {
    pub fn new(value: T) -> Self {
        StoreCell {
            value: Mutex::new(value),
            writes: Mutex::new(()),
        }
    }

    /// A copy of the current value.
    pub fn get(&self) -> T {
        lock(&self.value).clone()
    }

    /// `read` applied to the current value, without copying it.
    pub fn read<R>(&self, read: impl FnOnce(&T) -> R) -> R {
        read(&lock(&self.value))
    }

    /// Waits for the other writes to finish, then holds off new ones until the
    /// turn is dropped.
    pub fn begin_write(&self) -> WriteTurn<'_, T> {
        WriteTurn {
            _turn: lock(&self.writes),
            cell: self,
        }
    }
}

impl<T: Clone> WriteTurn<'_, T> {
    /// A copy of the value, to edit and persist.
    pub fn current(&self) -> T {
        self.cell.get()
    }

    /// Makes `value` current while the turn still holds, for a change that
    /// stands even if persisting it then fails.
    pub fn publish(&self, value: T) {
        *lock(&self.cell.value) = value;
    }

    /// Makes the persisted `value` the current one and ends the turn.
    pub fn commit(self, value: T) {
        *lock(&self.cell.value) = value;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    /// Starts a write on another thread that commits `value` once `release`
    /// gets a message, and returns when that write holds its turn.
    fn start_write(
        cell: &Arc<StoreCell<u32>>,
        value: u32,
    ) -> (mpsc::Sender<()>, thread::JoinHandle<()>) {
        let (release_tx, release_rx) = mpsc::channel();
        let (started_tx, started_rx) = mpsc::channel();
        let writer = Arc::clone(cell);
        let handle = thread::spawn(move || {
            let turn = writer.begin_write();
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            turn.commit(value);
        });
        started_rx.recv().unwrap();
        (release_tx, handle)
    }

    #[test]
    fn a_read_during_a_write_gets_the_old_value_without_waiting() {
        let cell = Arc::new(StoreCell::new(1));
        let (release, writer) = start_write(&cell, 2);

        assert_eq!(cell.get(), 1);
        assert_eq!(cell.read(|value| *value), 1);

        release.send(()).unwrap();
        writer.join().unwrap();
        assert_eq!(cell.get(), 2);
    }

    #[test]
    fn a_write_waits_for_the_one_before_and_starts_from_its_value() {
        let cell = Arc::new(StoreCell::new(1));
        let (release, first) = start_write(&cell, 2);
        let (seen_tx, seen_rx) = mpsc::channel();
        let second_cell = Arc::clone(&cell);
        let second = thread::spawn(move || {
            let turn = second_cell.begin_write();
            let current = turn.current();
            seen_tx.send(current).unwrap();
            turn.commit(current + 10);
        });

        assert!(seen_rx.recv_timeout(Duration::from_millis(50)).is_err());
        release.send(()).unwrap();
        first.join().unwrap();
        second.join().unwrap();

        assert_eq!(seen_rx.recv().unwrap(), 2);
        assert_eq!(cell.get(), 12);
    }

    #[test]
    fn a_turn_dropped_without_commit_keeps_the_value() {
        let cell = StoreCell::new(1);
        drop(cell.begin_write());
        assert_eq!(cell.get(), 1);
        cell.begin_write().commit(3);
        assert_eq!(cell.get(), 3);
    }

    #[test]
    fn a_published_value_is_read_before_the_turn_ends() {
        let cell = StoreCell::new(1);
        let turn = cell.begin_write();
        turn.publish(2);
        assert_eq!(cell.get(), 2);
        drop(turn);
        assert_eq!(cell.get(), 2);
    }
}
