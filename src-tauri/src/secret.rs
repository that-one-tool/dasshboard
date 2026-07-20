//! `SecretStore` (SPEC.md §4/§9): keeps device secrets out of `devices.json`
//! entirely. Real storage is the OS keyring; tests use `InMemorySecretStore`
//! so `cargo test` never touches the real OS credential manager.

#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::sync::Mutex;

use crate::error::AppError;

/// Service name used for every keyring entry (SPEC.md §4).
const SERVICE: &str = "DaSSHboard";

/// Secret storage keyed by device id. `get` is unused by Phase 1's commands
/// (no command reads a secret back to the frontend — SPEC.md §5/§8) but is
/// part of the trait now since Phase 2's SSH auth needs it and the trait
/// boundary is the right place to keep keyring access mockable.
pub trait SecretStore: Send + Sync {
    fn set(&self, device_id: &str, secret: &str) -> Result<(), AppError>;
    // Not called by any Phase 1 command (no command reads a secret back to
    // the frontend — SPEC.md §5/§8) or by production code yet at all; Phase
    // 2's SSH auth is the first real caller. Exercised by this module's own
    // tests today. `#[allow(dead_code)]` avoids a spurious warning on plain
    // `cargo build`/`cargo clippy`, where `#[cfg(test)]` code doesn't count
    // as a call site.
    #[allow(dead_code)]
    fn get(&self, device_id: &str) -> Result<Option<String>, AppError>;
    /// Deletes the secret for `device_id`. Idempotent: a missing entry is
    /// not an error (SPEC.md §5, `delete_device` notes).
    fn delete(&self, device_id: &str) -> Result<(), AppError>;
}

/// Real `SecretStore` backed by the OS credential manager via the `keyring`
/// crate (service `DaSSHboard`, account = device id).
pub struct KeyringSecretStore;

impl SecretStore for KeyringSecretStore {
    fn set(&self, device_id: &str, secret: &str) -> Result<(), AppError> {
        let entry = keyring::Entry::new(SERVICE, device_id).map_err(to_app_error)?;
        entry.set_password(secret).map_err(to_app_error)
    }

    fn get(&self, device_id: &str) -> Result<Option<String>, AppError> {
        let entry = keyring::Entry::new(SERVICE, device_id).map_err(to_app_error)?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(to_app_error(err)),
        }
    }

    fn delete(&self, device_id: &str) -> Result<(), AppError> {
        let entry = keyring::Entry::new(SERVICE, device_id).map_err(to_app_error)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(to_app_error(err)),
        }
    }
}

/// `keyring::Error`'s `Display` only ever describes the platform-level
/// failure (e.g. "no matching credential found", a Windows error code) — it
/// never echoes back the secret value — so surfacing it verbatim to the
/// frontend via `AppError::Keyring` does not leak secret material.
fn to_app_error(err: keyring::Error) -> AppError {
    AppError::Keyring(err.to_string())
}

/// In-memory fake for tests: implements the same trait, backed by a
/// `HashMap` guarded by a `Mutex`, so store/command tests never touch the
/// real OS keyring. Only compiled under `#[cfg(test)]` — it exists purely as
/// a test fixture (used from this module's tests and from `commands.rs`'s),
/// so gating it this way is both accurate and keeps plain `cargo
/// build`/`cargo clippy` from flagging it as dead code.
#[cfg(test)]
#[derive(Default)]
pub struct InMemorySecretStore {
    secrets: Mutex<HashMap<String, String>>,
}

#[cfg(test)]
impl InMemorySecretStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Test helper: true if a secret is currently stored for `device_id`.
    pub fn contains(&self, device_id: &str) -> bool {
        self.secrets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(device_id)
    }
}

#[cfg(test)]
impl SecretStore for InMemorySecretStore {
    fn set(&self, device_id: &str, secret: &str) -> Result<(), AppError> {
        self.secrets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(device_id.to_string(), secret.to_string());
        Ok(())
    }

    fn get(&self, device_id: &str) -> Result<Option<String>, AppError> {
        Ok(self
            .secrets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(device_id)
            .cloned())
    }

    fn delete(&self, device_id: &str) -> Result<(), AppError> {
        self.secrets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(device_id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_memory_set_then_get_round_trips() {
        let store = InMemorySecretStore::new();
        store.set("device-1", "hunter2").unwrap();
        assert_eq!(store.get("device-1").unwrap(), Some("hunter2".to_string()));
    }

    #[test]
    fn in_memory_get_missing_is_none_not_error() {
        let store = InMemorySecretStore::new();
        assert_eq!(store.get("nope").unwrap(), None);
    }

    #[test]
    fn in_memory_delete_missing_is_not_an_error() {
        let store = InMemorySecretStore::new();
        assert!(store.delete("nope").is_ok());
    }

    #[test]
    fn in_memory_delete_removes_secret() {
        let store = InMemorySecretStore::new();
        store.set("device-1", "hunter2").unwrap();
        assert!(store.contains("device-1"));
        store.delete("device-1").unwrap();
        assert!(!store.contains("device-1"));
        assert_eq!(store.get("device-1").unwrap(), None);
    }

    #[test]
    fn in_memory_set_overwrites_existing_secret() {
        let store = InMemorySecretStore::new();
        store.set("device-1", "old").unwrap();
        store.set("device-1", "new").unwrap();
        assert_eq!(store.get("device-1").unwrap(), Some("new".to_string()));
    }
}
