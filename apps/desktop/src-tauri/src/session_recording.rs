//! Recording a terminal session's output to a file: the raw bytes, escape
//! codes included, written as they arrive (like `script`).

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use crate::error::AppError;

/// Where one session's output is recorded, if anywhere.
#[derive(Default)]
pub(crate) struct Recorder {
    file: Mutex<Option<File>>,
}

impl Recorder {
    /// Record into `path` from now on: appended to it when `append` (a pane
    /// reconnecting), else replacing it.
    pub(crate) fn start(&self, path: &Path, append: bool) -> Result<(), AppError> {
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .append(append)
            .truncate(!append)
            .open(path)?;
        *self.lock() = Some(file);
        Ok(())
    }

    pub(crate) fn stop(&self) {
        self.lock().take();
    }

    #[cfg(test)]
    pub(crate) fn is_recording(&self) -> bool {
        self.lock().is_some()
    }

    /// Unbuffered, so the file follows the session live (`tail -f`). A failed
    /// write stops the recording: the file would miss output from then on.
    pub(crate) fn record(&self, bytes: &[u8]) -> std::io::Result<()> {
        let mut file = self.lock();
        let Some(open) = file.as_mut() else {
            return Ok(());
        };
        let written = open.write_all(bytes);
        if written.is_err() {
            file.take();
        }
        written
    }

    fn lock(&self) -> MutexGuard<'_, Option<File>> {
        self.file
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// The live sessions' recorders, by session id.
#[derive(Default)]
pub struct Recorders(Mutex<HashMap<String, Arc<Recorder>>>);

impl Recorders {
    /// A new recorder for session `id`, not recording yet.
    pub(crate) fn open(&self, id: &str) -> Arc<Recorder> {
        let recorder = Arc::new(Recorder::default());
        self.lock().insert(id.to_string(), Arc::clone(&recorder));
        recorder
    }

    pub(crate) fn get(&self, id: &str) -> Option<Arc<Recorder>> {
        self.lock().get(id).cloned()
    }

    /// Stop `recorder` and forget it, unless session `id` has another by now.
    pub(crate) fn remove(&self, id: &str, recorder: &Arc<Recorder>) {
        recorder.stop();
        let mut recorders = self.lock();
        if recorders.get(id).is_some_and(|r| Arc::ptr_eq(r, recorder)) {
            recorders.remove(id);
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, Arc<Recorder>>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(name);
        (dir, path)
    }

    #[test]
    fn records_nothing_until_started() {
        let recorder = Recorder::default();
        assert!(!recorder.is_recording());
        recorder.record(b"ignored").unwrap();
    }

    #[test]
    fn records_output_bytes_verbatim() {
        let (_dir, path) = temp_file("out.log");
        let recorder = Recorder::default();
        recorder.start(&path, false).unwrap();
        recorder.record(b"\x1b[1mhi\x1b[0m\r\n").unwrap();
        recorder.record(b"\xff").unwrap();
        assert!(recorder.is_recording());
        assert_eq!(std::fs::read(&path).unwrap(), b"\x1b[1mhi\x1b[0m\r\n\xff");
    }

    #[test]
    fn a_new_recording_replaces_the_file() {
        let (_dir, path) = temp_file("out.log");
        std::fs::write(&path, b"old").unwrap();
        let recorder = Recorder::default();
        recorder.start(&path, false).unwrap();
        recorder.record(b"new").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
    }

    #[test]
    fn a_continued_recording_appends_to_the_file() {
        let (_dir, path) = temp_file("out.log");
        std::fs::write(&path, b"before ").unwrap();
        let recorder = Recorder::default();
        recorder.start(&path, true).unwrap();
        recorder.record(b"after").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"before after");
    }

    #[test]
    fn output_after_stop_is_not_recorded() {
        let (_dir, path) = temp_file("out.log");
        let recorder = Recorder::default();
        recorder.start(&path, false).unwrap();
        recorder.record(b"kept").unwrap();
        recorder.stop();
        recorder.record(b"dropped").unwrap();
        assert!(!recorder.is_recording());
        assert_eq!(std::fs::read(&path).unwrap(), b"kept");
    }

    #[test]
    fn a_file_that_cannot_be_opened_is_an_error() {
        let (_dir, path) = temp_file("missing-dir/out.log");
        let recorder = Recorder::default();
        assert!(matches!(recorder.start(&path, false), Err(AppError::Io(_))));
        assert!(!recorder.is_recording());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_failed_write_stops_the_recording() {
        let recorder = Recorder::default();
        recorder.start(Path::new("/dev/full"), true).unwrap();
        assert!(recorder.record(b"x").is_err());
        assert!(!recorder.is_recording());
    }

    #[test]
    fn recorders_are_kept_by_session_until_removed() {
        let recorders = Recorders::default();
        let recorder = recorders.open("s1");
        assert!(Arc::ptr_eq(&recorders.get("s1").unwrap(), &recorder));
        recorders.remove("s1", &recorder);
        assert!(recorders.get("s1").is_none());
    }

    #[test]
    fn removing_a_recorder_stops_it() {
        let (_dir, path) = temp_file("out.log");
        let recorders = Recorders::default();
        let recorder = recorders.open("s1");
        recorder.start(&path, false).unwrap();
        recorders.remove("s1", &recorder);
        assert!(!recorder.is_recording());
    }

    #[test]
    fn removing_a_replaced_recorder_keeps_its_successor() {
        let recorders = Recorders::default();
        let old = recorders.open("s1");
        let new = recorders.open("s1");
        recorders.remove("s1", &old);
        assert!(Arc::ptr_eq(&recorders.get("s1").unwrap(), &new));
    }
}
