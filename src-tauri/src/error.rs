//! `AppError` — the error type returned by every Tauri command (SPEC.md §5).
//!
//! Wire shape is `{ code, message }`. `code` is one of the fixed strings
//! listed in SPEC.md §5: `NotFound`, `Io`, `Keyring`, `Validation` (Phase 1)
//! plus `SshAuth`, `SshConnect`, `SshChannel`, `HostKeyRejected` (Phase 2's
//! SSH session layer).
//!
//! Never construct a variant with secret material in its message — the
//! message crosses IPC to the frontend verbatim. In particular, SSH error
//! messages describe the failure category only; they never echo a password,
//! passphrase, or key contents.

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Io(String),
    #[error("{0}")]
    Keyring(String),
    #[error("{0}")]
    Validation(String),
    /// Authentication was refused by the server, or the credential needed to
    /// authenticate is missing from the keyring / unreadable.
    #[error("{0}")]
    SshAuth(String),
    /// The TCP connection or SSH transport handshake failed (host
    /// unreachable, connection refused, connect timeout, protocol error).
    #[error("{0}")]
    SshConnect(String),
    /// A session channel / PTY / shell request failed after authentication.
    #[error("{0}")]
    SshChannel(String),
    /// The user rejected the presented host key, the trust prompt timed out,
    /// or the prompt was dismissed (SPEC.md §6).
    #[error("{0}")]
    HostKeyRejected(String),
    /// A tunnel's local listener could not be bound — the local port is already
    /// in use, or binding it was refused (SPEC tunnels §5).
    #[error("{0}")]
    TunnelBind(String),
}

impl AppError {
    fn code(&self) -> &'static str {
        match self {
            AppError::NotFound(_) => "NotFound",
            AppError::Io(_) => "Io",
            AppError::Keyring(_) => "Keyring",
            AppError::Validation(_) => "Validation",
            AppError::SshAuth(_) => "SshAuth",
            AppError::SshConnect(_) => "SshConnect",
            AppError::SshChannel(_) => "SshChannel",
            AppError::HostKeyRejected(_) => "HostKeyRejected",
            AppError::TunnelBind(_) => "TunnelBind",
        }
    }
}

/// Serializes as `{ "code": "...", "message": "..." }` per SPEC.md §5. This
/// is a hand-rolled impl (rather than `#[derive(Serialize)]` on the enum)
/// because the wire shape is a fixed two-field object regardless of variant,
/// not an internally/externally tagged enum.
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("code", self.code())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

/// Maps a filesystem I/O failure to `AppError::Io`. The underlying
/// `std::io::Error` message may contain a file path but never secret
/// material, so it's safe to surface to the frontend.
impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        AppError::Io(err.to_string())
    }
}

/// Maps a JSON (de)serialization failure to `AppError::Io`, since in this
/// codebase it only ever occurs while persisting/loading store files.
impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        AppError::Io(err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_code_and_message() {
        let err = AppError::Validation("port must be between 1 and 65535".to_string());
        let value = serde_json::to_value(&err).expect("serialize AppError");
        assert_eq!(
            value,
            serde_json::json!({
                "code": "Validation",
                "message": "port must be between 1 and 65535",
            })
        );
    }

    #[test]
    fn every_variant_has_its_own_code() {
        let cases: Vec<(AppError, &str)> = vec![
            (AppError::NotFound("x".into()), "NotFound"),
            (AppError::Io("x".into()), "Io"),
            (AppError::Keyring("x".into()), "Keyring"),
            (AppError::Validation("x".into()), "Validation"),
            (AppError::SshAuth("x".into()), "SshAuth"),
            (AppError::SshConnect("x".into()), "SshConnect"),
            (AppError::SshChannel("x".into()), "SshChannel"),
            (AppError::HostKeyRejected("x".into()), "HostKeyRejected"),
            (AppError::TunnelBind("x".into()), "TunnelBind"),
        ];
        for (err, expected_code) in cases {
            assert_eq!(err.code(), expected_code);
        }
    }
}
