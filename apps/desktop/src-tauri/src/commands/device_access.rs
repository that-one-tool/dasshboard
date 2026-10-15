//! Resolving a saved device into what a connection needs: the device itself,
//! its credentials (keyring read off the async runtime), its jump host, and
//! the keepalive settings.

use std::sync::Arc;

use crate::device::{Auth, Connection, Device};
use crate::error::AppError;
use crate::session::{AuthCredentials, JumpHop, KeepaliveConfig};
use crate::state::AppState;

/// Look up a device by id (SPEC §5 `NotFound` on miss).
pub(super) fn find_device(state: &AppState, device_id: &str) -> Result<Device, AppError> {
    state
        .device_store
        .list()
        .into_iter()
        .find(|d| d.id == device_id)
        .ok_or_else(|| AppError::NotFound(format!("no device with id {device_id}")))
}

/// The key file a typed key path names: trimmed, with a leading `~` expanded
/// as a shell would (the stored path keeps the `~`, so an exported device
/// still works on another machine).
fn key_file_path(key_path: &str) -> String {
    crate::ssh_config::expand_tilde(key_path.trim(), crate::ssh_config::home_dir().as_deref())
}

/// Pure part of credential-building (SPEC §6): combine a device's auth method
/// with the secret already fetched from the keyring. No I/O — kept separate so
/// it is trivially unit-testable and so the blocking keyring read can happen
/// off the async runtime (see [`resolve_credentials`]). The secret never
/// leaves this function except inside the opaque [`AuthCredentials`], and never
/// appears in an error message.
fn credentials_from(auth: &Auth, stored: Option<String>) -> Result<AuthCredentials, AppError> {
    match auth {
        Auth::Password => {
            let password = stored.ok_or_else(|| {
                AppError::SshAuth(
                    "no password is stored for this device — open the device editor and re-enter it"
                        .to_string(),
                )
            })?;
            Ok(AuthCredentials::Password(password))
        }
        Auth::Key { key_path } => {
            // A missing keyring secret means an unencrypted key (SPEC §4), which
            // is valid — not an error.
            Ok(AuthCredentials::Key {
                path: key_file_path(key_path),
                passphrase: stored,
            })
        }
        Auth::Agent { fingerprint } => {
            // Agent auth stores no keyring secret — the agent holds the key — so
            // `stored` is ignored. Only the (public) fingerprint identifies which
            // agent identity to use.
            Ok(AuthCredentials::Agent {
                fingerprint: fingerprint.clone(),
            })
        }
    }
}

/// Fetch the device's keyring secret and build its [`AuthCredentials`] (SPEC
/// §6). The keyring read is a blocking OS call (Windows Credential Manager), so
/// it runs on `tokio::task::spawn_blocking` rather than directly on the async
/// runtime — a slow/contended keyring must never stall other sessions' PTY I/O
/// or keepalives. No lock is held across the `.await` (the `Arc<dyn
/// SecretStore>` is cloned out first).
pub(super) async fn resolve_credentials(
    state: &AppState,
    device: &Device,
) -> Result<AuthCredentials, AppError> {
    let auth = ssh_auth_of(device)?;
    let secret_store = Arc::clone(&state.secret_store);
    let device_id = device.id.clone();
    let stored = tokio::task::spawn_blocking(move || secret_store.get(&device_id))
        .await
        .map_err(|e| AppError::Keyring(format!("secret lookup task failed: {e}")))??;
    credentials_from(auth, stored)
}

/// Resolve a device's optional jump host (`ProxyJump`) into the connection
/// parameters a shell, tunnel or SFTP connection needs. `Ok(None)` for a device with no jump
/// configured. Errors (surfaced as a connect failure) when the referenced jump
/// device is missing or is a serial device, which cannot be a jump host. The
/// jump device's own keyring secret is read here, the same way the target's is.
pub(super) async fn resolve_jump_hop(
    state: &AppState,
    device: &Device,
) -> Result<Option<JumpHop>, AppError> {
    let Some(jump_id) = device.proxy_jump_id() else {
        return Ok(None);
    };
    let jump_device = find_device(state, jump_id).map_err(|_| {
        AppError::NotFound(format!(
            "this device's jump host (device {jump_id}) no longer exists"
        ))
    })?;
    match &jump_device.connection {
        Connection::Ssh {
            host,
            port,
            username,
            ..
        } => {
            let creds = resolve_credentials(state, &jump_device)
                .await
                .map_err(|e| name_jump_device(e, &jump_device.name))?;
            Ok(Some(JumpHop {
                host: host.clone(),
                port: *port,
                username: username.clone(),
                creds,
            }))
        }
        _ => Err(AppError::Validation(
            "the configured jump host is not an SSH device and cannot be used as a jump host"
                .to_string(),
        )),
    }
}

/// Prefix a jump device's credential error with its name, so the user fixes
/// that device rather than the one they connected to.
fn name_jump_device(err: AppError, name: &str) -> AppError {
    let prefix = format!("jump host \"{name}\": ");
    match err {
        AppError::SshAuth(m) => AppError::SshAuth(prefix + &m),
        AppError::Keyring(m) => AppError::Keyring(prefix + &m),
        other => other,
    }
}

/// The SSH `Auth` of a device, or an error for a serial device (which has no
/// credentials). `connect`/`test_connection` only call this on the SSH branch,
/// so the error is a defensive guard, never hit in the normal flow.
fn ssh_auth_of(device: &Device) -> Result<&Auth, AppError> {
    match &device.connection {
        Connection::Ssh { auth, .. } => Ok(auth),
        _ => Err(AppError::Validation(
            "this device kind has no SSH credentials".to_string(),
        )),
    }
}

/// Resolve the app-wide SSH keepalive settings into a [`KeepaliveConfig`] for a
/// new connection. Read fresh from the settings store on each connect, so a
/// changed keepalive applies to connections opened afterwards.
pub(super) fn keepalive_config(state: &AppState) -> KeepaliveConfig {
    let k = state.settings_store.get().keepalive;
    KeepaliveConfig::from_secs(k.interval_secs, k.count_max)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::devices::save_device_impl;
    use crate::commands::test_support::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn resolve_credentials_password_uses_stored_secret() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let saved = save_device_impl(&state, sample_device(), Some("hunter2".to_string())).unwrap();

        match &resolve_credentials(&state, &saved).await.unwrap() {
            AuthCredentials::Password(pw) => assert_eq!(pw, "hunter2"),
            other => panic!("expected password credentials, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn resolve_credentials_password_missing_secret_is_ssh_auth() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        // Saved with no secret ⇒ nothing in the keyring for a password device.
        let saved = save_device_impl(&state, sample_device(), None).unwrap();

        let err = resolve_credentials(&state, &saved).await.unwrap_err();
        assert!(
            matches!(err, AppError::SshAuth(_)),
            "a password device with no stored secret must fail with SshAuth"
        );
        // The error text must not leak anything secret-shaped (there is none here,
        // but assert it points the user at the editor, per SPEC §6).
        if let AppError::SshAuth(msg) = err {
            assert!(msg.to_lowercase().contains("device editor"));
        }
    }

    #[tokio::test]
    async fn a_jump_host_with_no_stored_password_is_named_in_the_error() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let bastion = Device {
            name: "bastion".to_string(),
            ..sample_device()
        };
        let bastion = save_device_impl(&state, bastion, None).unwrap();
        let mut target = sample_device();
        if let Connection::Ssh { proxy_jump, .. } = &mut target.connection {
            *proxy_jump = Some(bastion.id.clone());
        }
        let target = save_device_impl(&state, target, Some("hunter2".to_string())).unwrap();

        let Err(AppError::SshAuth(message)) = resolve_jump_hop(&state, &target).await else {
            panic!("a jump host with no stored password must fail with SshAuth");
        };
        assert!(
            message.starts_with("jump host \"bastion\": "),
            "the error must name the jump host, got: {message}"
        );
    }

    #[tokio::test]
    async fn resolve_credentials_key_without_passphrase_is_unencrypted() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let mut device = sample_device();
        set_ssh_auth(
            &mut device,
            Auth::Key {
                key_path: "C:/keys/id_ed25519".to_string(),
            },
        );
        // No secret ⇒ unencrypted key (SPEC §4), NOT an error.
        let saved = save_device_impl(&state, device, None).unwrap();

        match &resolve_credentials(&state, &saved).await.unwrap() {
            AuthCredentials::Key { path, passphrase } => {
                assert_eq!(path, "C:/keys/id_ed25519");
                assert_eq!(passphrase.as_deref(), None);
            }
            other => panic!("expected key credentials, got {other:?}"),
        }
    }

    fn key_path_of(key_path: &str) -> String {
        let auth = Auth::Key {
            key_path: key_path.to_string(),
        };
        match &credentials_from(&auth, None).unwrap() {
            AuthCredentials::Key { path, .. } => path.clone(),
            other => panic!("expected key credentials, got {other:?}"),
        }
    }

    #[test]
    fn key_path_is_trimmed() {
        assert_eq!(key_path_of("  /keys/id_ed25519 \t"), "/keys/id_ed25519");
    }

    #[test]
    fn key_path_expands_a_leading_tilde_to_the_home_dir() {
        let home = crate::ssh_config::home_dir().expect("tests run with a home dir");
        let path = key_path_of("~/.ssh/id_ed25519");
        assert!(
            path.starts_with(&home),
            "{path:?} should start with {home:?}"
        );
        assert!(path.ends_with("id_ed25519"));
    }

    #[tokio::test]
    async fn resolve_credentials_key_with_passphrase_carries_it() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let mut device = sample_device();
        set_ssh_auth(
            &mut device,
            Auth::Key {
                key_path: "C:/keys/id_ed25519".to_string(),
            },
        );
        let saved = save_device_impl(&state, device, Some("phrase".to_string())).unwrap();

        match &resolve_credentials(&state, &saved).await.unwrap() {
            AuthCredentials::Key { passphrase, .. } => {
                assert_eq!(passphrase.as_deref(), Some("phrase"));
            }
            other => panic!("expected key credentials, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn resolve_credentials_agent_carries_fingerprint_and_ignores_secret() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let mut device = sample_device();
        set_ssh_auth(
            &mut device,
            Auth::Agent {
                fingerprint: "SHA256:abc".to_string(),
            },
        );
        // Even if a stale secret were somehow stored, agent auth ignores it.
        let saved = save_device_impl(&state, device, Some("ignored".to_string())).unwrap();

        match &resolve_credentials(&state, &saved).await.unwrap() {
            AuthCredentials::Agent { fingerprint } => assert_eq!(fingerprint, "SHA256:abc"),
            other => panic!("expected agent credentials, got {other:?}"),
        }
    }

    #[test]
    fn find_device_unknown_id_is_not_found() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let err = find_device(&state, "nope").unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }
}
