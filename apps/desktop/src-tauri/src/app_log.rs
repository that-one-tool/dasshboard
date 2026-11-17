//! The app's diagnostic log, shown in Settings > Logs: the last lines kept in
//! memory, each also echoed to stderr. Never log secrets or terminal data.

use std::collections::VecDeque;
use std::io::Write;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Lines kept; older ones are dropped.
pub const LOG_CAPACITY: usize = 2000;
/// Longer messages are cut, so a runaway caller can't fill memory.
const MAX_MESSAGE_CHARS: usize = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

impl LogLevel {
    fn label(self) -> &'static str {
        match self {
            LogLevel::Info => "INFO",
            LogLevel::Warn => "WARN",
            LogLevel::Error => "ERROR",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    /// Milliseconds since the Unix epoch.
    pub time_ms: u64,
    pub level: LogLevel,
    pub message: String,
}

/// A bounded log: pushing past `capacity` drops the oldest line.
struct LogBuffer {
    entries: Mutex<VecDeque<LogEntry>>,
    capacity: usize,
}

impl LogBuffer {
    const fn new(capacity: usize) -> Self {
        LogBuffer {
            entries: Mutex::new(VecDeque::new()),
            capacity,
        }
    }

    fn lock(&self) -> MutexGuard<'_, VecDeque<LogEntry>> {
        self.entries.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn push(&self, entry: LogEntry) {
        let mut entries = self.lock();
        if entries.len() >= self.capacity {
            entries.pop_front();
        }
        entries.push_back(entry);
    }

    fn snapshot(&self) -> Vec<LogEntry> {
        self.lock().iter().cloned().collect()
    }

    fn clear(&self) {
        self.lock().clear();
    }
}

static LOG: LogBuffer = LogBuffer::new(LOG_CAPACITY);

pub fn info(message: impl Into<String>) {
    record(LogLevel::Info, message.into());
}

pub fn warn(message: impl Into<String>) {
    record(LogLevel::Warn, message.into());
}

pub fn error(message: impl Into<String>) {
    record(LogLevel::Error, message.into());
}

/// Keep `message` and echo it to stderr (outside the lock).
pub fn record(level: LogLevel, message: String) {
    let entry = LogEntry {
        time_ms: now_ms(),
        level,
        message: truncated(escape_controls(&message)),
    };
    let line = stderr_line(&entry);
    LOG.push(entry);
    write_line(&mut std::io::stderr().lock(), &line);
}

/// A forwarded channel's end: a reset, broken pipe or early EOF is how peers
/// usually hang up, so only other errors are warnings.
pub fn channel_ended(channel: &str, err: &std::io::Error) {
    let level = if is_hang_up(err.kind()) {
        LogLevel::Info
    } else {
        LogLevel::Warn
    };
    record(level, format!("{channel} channel ended: {err}"));
}

fn is_hang_up(kind: std::io::ErrorKind) -> bool {
    use std::io::ErrorKind::{BrokenPipe, ConnectionReset, UnexpectedEof};
    matches!(kind, ConnectionReset | BrokenPipe | UnexpectedEof)
}

/// The kept lines, oldest first.
pub fn entries() -> Vec<LogEntry> {
    LOG.snapshot()
}

pub fn clear() {
    LOG.clear();
}

fn now_ms() -> u64 {
    let since_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    u64::try_from(since_epoch.as_millis()).unwrap_or(u64::MAX)
}

/// Server-sent text (a disconnect message) could otherwise carry terminal
/// escape sequences to stderr, or newlines that forge log lines.
fn escape_controls(message: &str) -> String {
    let mut escaped = String::with_capacity(message.len());
    for c in message.chars() {
        if c.is_control() {
            escaped.extend(c.escape_debug());
        } else {
            escaped.push(c);
        }
    }
    escaped
}

/// Unlike `eprintln!`, never panics when stderr is closed (a closed terminal).
fn write_line(out: &mut impl Write, line: &str) {
    let _ = writeln!(out, "{line}");
}

fn truncated(message: String) -> String {
    match message.char_indices().nth(MAX_MESSAGE_CHARS) {
        Some((cut, _)) => format!("{}…", &message[..cut]),
        None => message,
    }
}

fn stderr_line(entry: &LogEntry) -> String {
    format!("[DaSSHboard] {} {}", entry.level.label(), entry.message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(message: &str) -> LogEntry {
        LogEntry {
            time_ms: 1,
            level: LogLevel::Info,
            message: message.to_string(),
        }
    }

    fn messages(buffer: &LogBuffer) -> Vec<String> {
        buffer.snapshot().into_iter().map(|e| e.message).collect()
    }

    #[test]
    fn keeps_entries_oldest_first() {
        let buffer = LogBuffer::new(3);
        buffer.push(entry("a"));
        buffer.push(entry("b"));
        assert_eq!(messages(&buffer), ["a", "b"]);
    }

    #[test]
    fn a_full_buffer_drops_the_oldest_entry() {
        let buffer = LogBuffer::new(2);
        for message in ["a", "b", "c"] {
            buffer.push(entry(message));
        }
        assert_eq!(messages(&buffer), ["b", "c"]);
    }

    #[test]
    fn clear_empties_the_buffer() {
        let buffer = LogBuffer::new(2);
        buffer.push(entry("a"));
        buffer.clear();
        assert!(buffer.snapshot().is_empty());
    }

    #[test]
    fn a_recorded_line_is_kept_with_its_level_and_time() {
        warn("app_log test: unique warning line");
        let kept = entries()
            .into_iter()
            .find(|e| e.message == "app_log test: unique warning line")
            .expect("kept");
        assert_eq!(kept.level, LogLevel::Warn);
        assert!(kept.time_ms > 1_600_000_000_000);
    }

    #[test]
    fn a_long_message_is_cut() {
        let long = "x".repeat(MAX_MESSAGE_CHARS + 50);
        let cut = truncated(long);
        assert_eq!(cut.chars().count(), MAX_MESSAGE_CHARS + 1);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn a_short_message_is_kept_whole() {
        assert_eq!(truncated("héllo".to_string()), "héllo");
    }

    #[test]
    fn control_characters_are_escaped_so_a_server_cannot_forge_lines() {
        warn("app_log test: \x1b]52;c;x\x07\nfake");
        let kept = entries()
            .into_iter()
            .any(|e| e.message == "app_log test: \\u{1b}]52;c;x\\u{7}\\nfake");
        assert!(kept);
    }

    #[test]
    fn escaping_happens_before_the_cap() {
        let long = "\n".repeat(MAX_MESSAGE_CHARS);
        let cut = truncated(escape_controls(&long));
        assert_eq!(cut.chars().count(), MAX_MESSAGE_CHARS + 1);
        assert!(cut.starts_with("\\n\\n"));
    }

    fn level_of(message: &str) -> LogLevel {
        entries()
            .into_iter()
            .find(|e| e.message == message)
            .expect("kept")
            .level
    }

    #[test]
    fn a_channel_hung_up_on_is_informational() {
        let reset = std::io::Error::new(std::io::ErrorKind::ConnectionReset, "reset");
        channel_ended("app_log test reset", &reset);
        let line = "app_log test reset channel ended: reset";
        assert_eq!(level_of(line), LogLevel::Info);
    }

    #[test]
    fn a_channel_failure_is_a_warning() {
        let denied = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "wrong cookie");
        channel_ended("app_log test denied", &denied);
        let line = "app_log test denied channel ended: wrong cookie";
        assert_eq!(level_of(line), LogLevel::Warn);
    }

    struct ClosedStderr;

    impl Write for ClosedStderr {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }
    }

    #[test]
    fn a_closed_stderr_is_ignored() {
        write_line(&mut ClosedStderr, "lost");
    }

    #[test]
    fn the_stderr_line_names_the_app_and_level() {
        let mut line = entry("lost");
        line.level = LogLevel::Error;
        assert_eq!(stderr_line(&line), "[DaSSHboard] ERROR lost");
    }

    #[test]
    fn an_entry_serializes_in_camel_case_with_a_lowercase_level() {
        let json = serde_json::to_value(entry("m")).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "timeMs": 1, "level": "info", "message": "m" })
        );
    }
}
