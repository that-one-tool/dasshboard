//! Filesystem watcher on the app-config directory (multi-instance sync).
//!
//! Each config file (`devices.json`, `profiles.json`, `settings.json`,
//! `known_hosts.json`) is read once into an in-memory cache at startup, so a
//! change made by a *second* running app instance is otherwise invisible until
//! restart. This watcher notices such a change on disk and emits a single
//! debounced [`CONFIG_CHANGED_EVENT`] to every window; the frontend answers it
//! by calling `reload_config` (which re-reads the files into memory) and
//! re-rendering. The manual "Reload" button drives the same frontend path, so
//! this watcher is purely the automatic layer on top.

use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use notify::{Event, EventKind, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

/// Emitted (debounced) whenever a watched config file changes on disk.
pub const CONFIG_CHANGED_EVENT: &str = "config_changed";

/// Coalesce a burst of raw filesystem events (an atomic rename fires several)
/// into one emit. Long enough to absorb the rename storm, short enough that a
/// cross-instance change still feels immediate.
const DEBOUNCE: Duration = Duration::from_millis(300);

/// The config file basenames whose change should trigger a reload. The
/// atomic-write temp files (`*.tmp-<uuid>`) and corrupt backups
/// (`*.corrupt-<secs>`) are intentionally excluded, so only the final rename
/// onto one of these names wakes the frontend.
const WATCHED_FILES: [&str; 4] = [
    "devices.json",
    "profiles.json",
    "settings.json",
    "known_hosts.json",
];

/// Whether a raw event touches one of the watched config files (by exact
/// basename). Pure access events (reads) are ignored — only writes, renames,
/// and removes matter.
fn is_config_change(event: &Event) -> bool {
    if matches!(event.kind, EventKind::Access(_)) {
        return false;
    }
    event.paths.iter().any(|p| {
        p.file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|name| WATCHED_FILES.contains(&name))
    })
}

/// Starts watching `config_dir` on a dedicated thread, emitting a debounced
/// [`CONFIG_CHANGED_EVENT`] to all windows on any change to a watched file.
///
/// Best-effort: a watcher that fails to initialize or bind logs a line and the
/// app simply runs without automatic multi-instance sync (the manual Reload
/// button still works). The directory is created first if missing, because the
/// watcher cannot bind a non-existent path and the config dir is otherwise
/// created lazily on the first save.
pub fn spawn(app: AppHandle, config_dir: PathBuf) {
    // A named OS thread (not a tokio task): the notify watcher and its blocking
    // channel drain are synchronous, and this lives for the whole app run.
    let _ = std::thread::Builder::new()
        .name("config-watcher".into())
        .spawn(move || run(app, config_dir));
}

fn run(app: AppHandle, config_dir: PathBuf) {
    if let Err(err) = std::fs::create_dir_all(&config_dir) {
        eprintln!("[DaSSHboard] config watcher: could not create {config_dir:?} ({err}); automatic reload disabled");
        return;
    }

    // notify delivers events to this channel from its own thread; we own the
    // receiving side and drain it with a debounce below.
    let (tx, rx) = mpsc::channel();
    let mut watcher = match notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(event) = res {
            // `send` only fails once `rx` is dropped (the loop ended); ignore.
            let _ = tx.send(event);
        }
    }) {
        Ok(w) => w,
        Err(err) => {
            eprintln!("[DaSSHboard] config watcher init failed ({err}); automatic reload disabled");
            return;
        }
    };
    if let Err(err) = watcher.watch(&config_dir, RecursiveMode::NonRecursive) {
        eprintln!("[DaSSHboard] config watcher could not watch {config_dir:?} ({err}); automatic reload disabled");
        return;
    }

    // `watcher` must stay alive for events to keep flowing, so it is held for
    // the whole of this loop (the loop only ends if the channel disconnects).
    loop {
        // Block until the first event of a burst.
        let first = match rx.recv() {
            Ok(event) => event,
            Err(_) => return, // sender gone (only if the watcher was dropped)
        };
        let mut relevant = is_config_change(&first);
        // Coalesce everything arriving within the debounce window into this one
        // emit (an atomic temp-write + rename alone produces several events).
        loop {
            match rx.recv_timeout(DEBOUNCE) {
                Ok(event) => relevant |= is_config_change(&event),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
        if relevant {
            // Broadcast to every window; a dropped emit (window gone) is fine.
            let _ = app.emit(CONFIG_CHANGED_EVENT, ());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, CreateKind, ModifyKind, RenameMode};
    use std::path::PathBuf;

    fn event(kind: EventKind, path: &str) -> Event {
        Event {
            kind,
            paths: vec![PathBuf::from(path)],
            attrs: Default::default(),
        }
    }

    #[test]
    fn matches_a_watched_file_write() {
        let e = event(EventKind::Modify(ModifyKind::Any), "/cfg/devices.json");
        assert!(is_config_change(&e));
    }

    #[test]
    fn matches_every_watched_file() {
        for name in WATCHED_FILES {
            let e = event(EventKind::Create(CreateKind::Any), &format!("/cfg/{name}"));
            assert!(is_config_change(&e), "{name} should be watched");
        }
    }

    #[test]
    fn ignores_atomic_write_temp_files() {
        // The `*.tmp-<uuid>` staging file must not trigger a reload; only the
        // final rename onto the real name should.
        let e = event(
            EventKind::Create(CreateKind::Any),
            "/cfg/devices.json.tmp-1234",
        );
        assert!(!is_config_change(&e));
    }

    #[test]
    fn ignores_corrupt_backups() {
        let e = event(
            EventKind::Create(CreateKind::Any),
            "/cfg/profiles.json.corrupt-1700000000",
        );
        assert!(!is_config_change(&e));
    }

    #[test]
    fn ignores_unrelated_files() {
        let e = event(EventKind::Modify(ModifyKind::Any), "/cfg/notes.txt");
        assert!(!is_config_change(&e));
    }

    #[test]
    fn ignores_pure_access_events_even_on_a_watched_file() {
        // A read of devices.json must not be mistaken for a change.
        let e = event(EventKind::Access(AccessKind::Read), "/cfg/devices.json");
        assert!(!is_config_change(&e));
    }

    #[test]
    fn matches_rename_destination_onto_a_watched_file() {
        // The atomic write finishes by renaming the temp file onto the real
        // name — that final event carries the watched basename.
        let e = event(
            EventKind::Modify(ModifyKind::Name(RenameMode::To)),
            "/cfg/settings.json",
        );
        assert!(is_config_change(&e));
    }
}
