//! Connection lifecycle lines for the diagnostic log (`app_log`): connect
//! timing, auth method outcomes, host-key verdicts and why a link ended.
//! Never credentials, prompt answers or terminal data.

use std::future::Future;
use std::time::Instant;

use russh::client::{AuthResult, DisconnectReason};
use russh::MethodKind;

use crate::app_log::{self, LogLevel};
use crate::error::AppError;
use crate::known_hosts::Verdict;

/// Run `connect`, logging its start, then its outcome with how long it took.
pub(crate) async fn timed_connect<T>(
    label: &str,
    connect: impl Future<Output = Result<T, AppError>>,
) -> Result<T, AppError> {
    app_log::info(format!("{label}: connecting"));
    let mut pending = PendingConnect {
        label,
        started: Instant::now(),
        settled: false,
    };
    let result = connect.await;
    pending.settled = true;
    let elapsed_ms = pending.started.elapsed().as_millis();
    let (level, line) = connect_outcome_line(label, elapsed_ms, result.as_ref().err());
    app_log::record(level, line);
    result
}

/// Logs a connect given up on (its future dropped: the user cancelled).
struct PendingConnect<'a> {
    label: &'a str,
    started: Instant,
    settled: bool,
}

impl Drop for PendingConnect<'_> {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        let elapsed_ms = self.started.elapsed().as_millis();
        app_log::info(format!(
            "{}: connect abandoned after {elapsed_ms} ms",
            self.label
        ));
    }
}

fn connect_outcome_line(
    label: &str,
    elapsed_ms: u128,
    error: Option<&AppError>,
) -> (LogLevel, String) {
    match error {
        None => (
            LogLevel::Info,
            format!("{label}: connected after {elapsed_ms} ms (including prompts)"),
        ),
        Some(err) => (
            LogLevel::Warn,
            format!("{label}: connect failed after {elapsed_ms} ms: {err}"),
        ),
    }
}

pub(crate) fn log_auth_attempt(label: &str, method: MethodKind, result: &AuthResult) {
    app_log::info(auth_line(label, method, result));
}

fn auth_line(label: &str, method: MethodKind, result: &AuthResult) -> String {
    let method = <&str>::from(&method);
    let AuthResult::Failure {
        remaining_methods,
        partial_success,
    } = result
    else {
        return format!("{label}: {method} authentication accepted");
    };
    let remaining: Vec<&str> = remaining_methods.iter().map(<&str>::from).collect();
    let outcome = if *partial_success {
        "partly accepted"
    } else {
        "rejected"
    };
    format!(
        "{label}: {method} authentication {outcome}; server allows: {}",
        remaining.join(", ")
    )
}

pub(crate) fn log_host_key_verdict(label: &str, key_type: &str, verdict: &Verdict) {
    let level = match verdict {
        Verdict::Changed => LogLevel::Warn,
        _ => LogLevel::Info,
    };
    app_log::record(level, host_key_line(label, key_type, verdict));
}

/// Indexed by `Verdict` in declaration order.
const VERDICT_TEXT: [&str; 4] = [
    "new (asking the user)",
    "trusted",
    "CHANGED since it was trusted (asking the user)",
    "unverifiable after a trust reset (asking the user)",
];

fn host_key_line(label: &str, key_type: &str, verdict: &Verdict) -> String {
    let verdict = VERDICT_TEXT[verdict.clone() as usize];
    format!("{label}: {key_type} host key {verdict}")
}

pub(crate) fn log_host_key_decision(label: &str, accepted: bool) {
    let decision = if accepted {
        "accepted"
    } else {
        "rejected or timed out"
    };
    app_log::info(format!("{label}: host key {decision}"));
}

pub(crate) fn log_disconnect(label: &str, reason: &DisconnectReason<russh::Error>) {
    let (level, line) = disconnect_line(label, reason);
    app_log::record(level, line);
}

fn disconnect_line(label: &str, reason: &DisconnectReason<russh::Error>) -> (LogLevel, String) {
    match reason {
        DisconnectReason::ReceivedDisconnect(info) => (
            LogLevel::Info,
            format!(
                "{label}: the server closed the connection ({:?}) {}",
                info.reason_code, info.message
            ),
        ),
        DisconnectReason::Error(russh::Error::Disconnect) => (
            LogLevel::Info,
            format!("{label}: connection closed (locally or by the server, no reason given)"),
        ),
        DisconnectReason::Error(err) => {
            (LogLevel::Warn, format!("{label}: connection lost: {err}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::client::RemoteDisconnectInfo;
    use russh::MethodSet;

    #[test]
    fn a_connect_outcome_names_its_duration() {
        let ok = connect_outcome_line("shell h:22", 42, None);
        assert_eq!(
            ok,
            (
                LogLevel::Info,
                "shell h:22: connected after 42 ms (including prompts)".to_string()
            )
        );
        let err = AppError::SshConnect("refused".to_string());
        let (level, line) = connect_outcome_line("SFTP h:22", 7, Some(&err));
        assert_eq!(level, LogLevel::Warn);
        assert!(line.starts_with("SFTP h:22: connect failed after 7 ms: "));
        assert!(line.contains("refused"));
    }

    #[tokio::test]
    async fn timed_connect_returns_the_connect_result() {
        let ok = timed_connect("test h:22", async { Ok::<_, AppError>(5) }).await;
        assert_eq!(ok.unwrap(), 5);
        let failed: Result<(), AppError> =
            timed_connect("test h:22", async { Err(AppError::SshAuth("no".into())) }).await;
        assert!(failed.is_err());
    }

    #[tokio::test]
    async fn an_abandoned_connect_is_logged() {
        let label = "test abandoned.example:22";
        let never = timed_connect(label, std::future::pending::<Result<(), AppError>>());
        let _ = tokio::time::timeout(std::time::Duration::from_millis(5), never).await;
        let logged = app_log::entries().iter().any(|e| {
            e.message
                .starts_with(&format!("{label}: connect abandoned after"))
        });
        assert!(logged);
    }

    #[test]
    fn an_accepted_auth_names_the_method() {
        let line = auth_line("shell h:22", MethodKind::PublicKey, &AuthResult::Success);
        assert_eq!(line, "shell h:22: publickey authentication accepted");
    }

    #[test]
    fn a_rejected_auth_names_what_the_server_allows() {
        let result = AuthResult::Failure {
            remaining_methods: MethodSet::from(&[MethodKind::KeyboardInteractive][..]),
            partial_success: false,
        };
        let line = auth_line("shell h:22", MethodKind::Password, &result);
        assert_eq!(
            line,
            "shell h:22: password authentication rejected; server allows: keyboard-interactive"
        );
    }

    #[test]
    fn a_partial_success_is_told_apart() {
        let result = AuthResult::Failure {
            remaining_methods: MethodSet::from(&[MethodKind::KeyboardInteractive][..]),
            partial_success: true,
        };
        assert!(auth_line("x", MethodKind::PublicKey, &result).contains("partly accepted"));
    }

    #[test]
    fn host_key_lines_name_the_verdict() {
        assert_eq!(
            host_key_line("shell h:22", "ssh-ed25519", &Verdict::Known),
            "shell h:22: ssh-ed25519 host key trusted"
        );
        assert_eq!(
            host_key_line("x", "k", &Verdict::Unknown),
            "x: k host key new (asking the user)"
        );
        assert_eq!(
            host_key_line("x", "k", &Verdict::Changed),
            "x: k host key CHANGED since it was trusted (asking the user)"
        );
        assert_eq!(
            host_key_line("x", "k", &Verdict::Unverifiable),
            "x: k host key unverifiable after a trust reset (asking the user)"
        );
    }

    #[test]
    fn a_lost_link_is_a_warning_naming_the_cause() {
        let reason = DisconnectReason::Error(russh::Error::KeepaliveTimeout);
        let (level, line) = disconnect_line("tunnel h:22", &reason);
        assert_eq!(level, LogLevel::Warn);
        assert_eq!(line, "tunnel h:22: connection lost: Keepalive timeout");
    }

    #[test]
    fn a_local_close_is_informational() {
        let reason = DisconnectReason::Error(russh::Error::Disconnect);
        assert_eq!(
            disconnect_line("SFTP h:22", &reason),
            (
                LogLevel::Info,
                "SFTP h:22: connection closed (locally or by the server, no reason given)"
                    .to_string()
            )
        );
    }

    #[test]
    fn a_server_disconnect_names_its_reason() {
        let reason = DisconnectReason::ReceivedDisconnect(RemoteDisconnectInfo {
            reason_code: russh::Disconnect::ByApplication,
            message: "bye".to_string(),
            lang_tag: String::new(),
        });
        let (level, line) = disconnect_line("shell h:22", &reason);
        assert_eq!(level, LogLevel::Info);
        assert_eq!(
            line,
            "shell h:22: the server closed the connection (ByApplication) bye"
        );
    }
}
