//! The diagnostic log (Logs dialog): read, clear, and lines from the frontend.

use crate::app_log::{self, LogEntry, LogLevel};

/// The kept log lines, oldest first. A memory copy under a brief lock.
#[tauri::command]
pub fn get_logs() -> Vec<LogEntry> {
    app_log::entries()
}

#[tauri::command]
pub fn clear_logs() {
    app_log::clear();
}

/// A line from the frontend (slow IPC, a stalled terminal). Async: echoing it
/// to stderr is a write, kept off the main thread.
#[tauri::command]
pub async fn log_frontend(level: LogLevel, message: String) {
    app_log::record(level, frontend_line(&message));
}

fn frontend_line(message: &str) -> String {
    format!("ui: {message}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frontend_line_is_marked_as_such() {
        assert_eq!(
            frontend_line("read_output took 9000 ms"),
            "ui: read_output took 9000 ms"
        );
    }

    #[tokio::test]
    async fn a_frontend_line_is_kept() {
        log_frontend(LogLevel::Error, "logs command test line".to_string()).await;
        let kept = get_logs()
            .into_iter()
            .any(|e| e.message == "ui: logs command test line" && e.level == LogLevel::Error);
        assert!(kept);
    }
}
