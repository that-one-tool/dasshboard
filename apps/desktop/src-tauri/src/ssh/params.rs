//! What a connection authenticates with and how it is kept alive.

use std::time::Duration;

use russh::MethodKind;
use zeroize::{Zeroize, Zeroizing};

/// SSH keepalive configuration for a connection, resolved from user settings
/// (`KeepaliveSettings`) by the command layer and carried on the `SshHandler`
/// so it reaches the `client::Config` built in `establish_over_stream` without
/// threading an extra parameter through every establish function. russh drives
/// the pings natively (see `client::Config::keepalive_interval`/`keepalive_max`):
/// it sends a keepalive when the link is idle and drops the connection after
/// `max` consecutive unanswered pings — the real dead-peer detection the old
/// hand-rolled `send_keepalive(false)` loop lacked.
#[derive(Debug, Clone, Copy)]
pub struct KeepaliveConfig {
    /// `None` disables keepalive; `Some(d)` sends a ping after `d` of idleness.
    pub interval: Option<Duration>,
    /// Consecutive unanswered pings tolerated before the connection is dropped.
    pub max: usize,
}

impl KeepaliveConfig {
    /// Build from the persisted `(interval_secs, count_max)` pair: `0` seconds
    /// disables keepalive; `count_max` is floored at 1 (russh treats 0 oddly).
    pub fn from_secs(interval_secs: u32, count_max: u32) -> Self {
        KeepaliveConfig {
            interval: (interval_secs > 0).then(|| Duration::from_secs(interval_secs as u64)),
            max: count_max.max(1) as usize,
        }
    }

    /// Keepalive off — used where liveness doesn't matter (e.g. the one-shot
    /// `test_connection`).
    pub fn disabled() -> Self {
        KeepaliveConfig {
            interval: None,
            max: 3,
        }
    }
}

/// The credential a device authenticates with. Constructed in `commands/device_access.rs`
/// from the device's auth method + the keyring secret; the secret never
/// appears in any event, log, or error message.
#[derive(Clone)]
pub enum AuthCredentials {
    Password(String),
    Key {
        path: String,
        passphrase: Option<String>,
    },
    /// Authenticate via the local SSH agent, using the identity whose SHA256
    /// fingerprint matches `fingerprint`. The agent (which may be backed by a
    /// hardware token) holds the private key and performs the signing; no key
    /// material ever enters this process. The fingerprint is a public identifier,
    /// not a secret.
    Agent {
        fingerprint: String,
    },
}

impl AuthCredentials {
    /// The SSH auth method these credentials try first.
    pub(super) fn method_kind(&self) -> MethodKind {
        match self {
            AuthCredentials::Password(_) => MethodKind::Password,
            AuthCredentials::Key { .. } | AuthCredentials::Agent { .. } => MethodKind::PublicKey,
        }
    }

    /// The saved password, which may also answer a keyboard-interactive
    /// password question.
    pub(super) fn saved_password(&self) -> Option<Zeroizing<String>> {
        let AuthCredentials::Password(password) = self else {
            return None;
        };
        Some(Zeroizing::new(password.clone()))
    }
}

/// Wipe the secret once the connection no longer needs it (the copy russh
/// takes for password auth is beyond reach).
impl Drop for AuthCredentials {
    fn drop(&mut self) {
        match self {
            AuthCredentials::Password(password) => password.zeroize(),
            AuthCredentials::Key { passphrase, .. } => passphrase.zeroize(),
            AuthCredentials::Agent { .. } => {}
        }
    }
}

/// Hand-rolled `Debug` that redacts the password/passphrase. The derived impl
/// would print the raw secret, which is reachable from test-only `panic!`
/// messages (`build_credentials_*` assertions) — this keeps the codebase's
/// "the secret never leaves this type in the clear" invariant true even in
/// test output on an assertion failure.
impl std::fmt::Debug for AuthCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthCredentials::Password(_) => f.write_str("Password(<redacted>)"),
            AuthCredentials::Key { path, .. } => f
                .debug_struct("Key")
                .field("path", path)
                .field("passphrase", &"<redacted>")
                .finish(),
            // `fingerprint` is a public identifier (no secret), so it is safe to
            // print — but keep the shape consistent with the redacting variants.
            AuthCredentials::Agent { fingerprint } => f
                .debug_struct("Agent")
                .field("fingerprint", fingerprint)
                .finish(),
        }
    }
}

/// The SSH server a connection authenticates to, as [`establish_target`](super::establish::establish_target) takes
/// it — borrowed from a shell's, tunnel's or SFTP connection's own params.
pub(crate) struct Endpoint<'a> {
    pub(crate) host: &'a str,
    pub(crate) port: u16,
    pub(crate) username: &'a str,
    pub(crate) creds: &'a AuthCredentials,
}

/// The resolved connection parameters for a single jump hop (`ProxyJump`),
/// built by the `connect`, `test_connection`, `start_tunnel` and `sftp_connect`
/// commands from the referenced jump device + its keyring secret. Deliberately
/// has no `Debug` impl, so the secret inside `creds` can't be `{:?}`-printed (the secret would still be redacted by `AuthCredentials`'s
/// own `Debug` were one ever derived here).
///
/// `pub` + `#[doc(hidden)]` for the same integration-test reason as
/// [`ConnectParams`].
#[doc(hidden)]
pub struct JumpHop {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub creds: AuthCredentials,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> AuthCredentials {
        AuthCredentials::Key {
            path: "k".into(),
            passphrase: Some("pp".into()),
        }
    }

    fn agent() -> AuthCredentials {
        AuthCredentials::Agent {
            fingerprint: "SHA256:x".into(),
        }
    }

    #[test]
    fn each_credential_names_the_ssh_method_it_tries() {
        let password = AuthCredentials::Password("pw".into());
        assert_eq!(password.method_kind(), MethodKind::Password);
        assert_eq!(key().method_kind(), MethodKind::PublicKey);
        assert_eq!(agent().method_kind(), MethodKind::PublicKey);
    }

    #[test]
    fn only_a_password_credential_has_a_saved_password() {
        let password = AuthCredentials::Password("pw".into());
        assert_eq!(
            password.saved_password().as_deref().map(String::as_str),
            Some("pw")
        );
        assert!(
            key().saved_password().is_none(),
            "a passphrase is no password"
        );
        assert!(agent().saved_password().is_none());
    }
}
