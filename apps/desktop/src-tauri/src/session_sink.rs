//! How a terminal session (SSH, serial or local shell) reports to the frontend:
//! its lifecycle [`SessionStatus`] and the [`SessionSink`] it streams into.

use crate::error::AppError;
use crate::ssh::prompts::HostKeyPromptPayload;

/// Lifecycle status mirrored to the frontend `session_status` event
/// (SPEC.md §5). Serializes to the exact lowercase strings in the spec.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionStatus {
    Connecting,
    Connected,
    /// Ended by the user, or the connection was lost (auto-reconnect applies).
    Disconnected,
    /// The shell ended on its own with exit code 0 (`exit`, `logout`, ...): the
    /// frontend must not auto-reconnect it. Any other end — a failure code, a
    /// kill by signal (e.g. a reboot), no exit status at all — is
    /// `Disconnected`.
    Exited,
    Error,
}

impl SessionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionStatus::Connecting => "connecting",
            SessionStatus::Connected => "connected",
            SessionStatus::Disconnected => "disconnected",
            SessionStatus::Exited => "exited",
            SessionStatus::Error => "error",
        }
    }

    /// Whether the session is over (no more output will come).
    pub(crate) fn is_final(self) -> bool {
        !matches!(self, SessionStatus::Connecting | SessionStatus::Connected)
    }

    /// The final status of a shell that ended on its own, from its exit code
    /// (`None` when none was reported): only a clean exit is `Exited`.
    pub(crate) fn for_shell_exit(exit_code: Option<u32>) -> SessionStatus {
        if exit_code == Some(0) {
            SessionStatus::Exited
        } else {
            SessionStatus::Disconnected
        }
    }
}

/// Sink for everything the SSH core needs to surface to the frontend. The
/// production impl emits Tauri events / streams over the IPC channel; the test
/// impl records into channels. Kept object-safe (`Arc<dyn SessionSink>`).
pub trait SessionSink: Send + Sync {
    /// Verbatim server output bytes → per-session IPC channel (SPEC.md §3).
    fn on_data(&self, bytes: &[u8]);
    /// A lifecycle change → `session_status` event.
    fn on_status(&self, status: SessionStatus, message: Option<String>);
    /// The session ended on `err` → an `error` `session_status` event. The
    /// production sink adds the error's code, so the frontend can tell a drop
    /// worth retrying from a failure a retry would only repeat (a wrong
    /// password, a rejected host key).
    fn on_error(&self, err: &AppError) {
        self.on_status(SessionStatus::Error, Some(err.to_string()));
    }
    /// An unknown/changed host key needs the user's decision →
    /// `host_key_prompt` event.
    fn on_host_key_prompt(&self, payload: HostKeyPromptPayload);
    /// The backend stopped waiting on a prompt (answered, timed out, or its
    /// connection was torn down) → `host_key_prompt_closed` event, so the
    /// dialog can drop a prompt that can no longer be answered.
    fn on_host_key_prompt_closed(&self, _prompt_id: &str) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_status_serializes_to_spec_strings() {
        assert_eq!(SessionStatus::Connecting.as_str(), "connecting");
        assert_eq!(SessionStatus::Connected.as_str(), "connected");
        assert_eq!(SessionStatus::Disconnected.as_str(), "disconnected");
        assert_eq!(SessionStatus::Error.as_str(), "error");
        assert_eq!(SessionStatus::Exited.as_str(), "exited");
    }

    #[test]
    fn only_an_ended_session_has_a_final_status() {
        assert!(!SessionStatus::Connecting.is_final());
        assert!(!SessionStatus::Connected.is_final());
        assert!(SessionStatus::Disconnected.is_final());
        assert!(SessionStatus::Exited.is_final());
        assert!(SessionStatus::Error.is_final());
    }

    #[test]
    fn only_a_clean_shell_exit_is_exited() {
        assert_eq!(
            SessionStatus::for_shell_exit(Some(0)),
            SessionStatus::Exited
        );
        assert_eq!(
            SessionStatus::for_shell_exit(Some(1)),
            SessionStatus::Disconnected
        );
        assert_eq!(
            SessionStatus::for_shell_exit(None),
            SessionStatus::Disconnected
        );
    }
}
