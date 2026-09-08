//! Tauri managed state: the device store, the `SecretStore` impl the app was
//! wired with (real keyring in production, `InMemorySecretStore` in tests),
//! and — starting Phase 2 — the `SessionManager` that owns all live SSH
//! sessions and the host-key trust machinery.

use std::sync::Arc;

use crate::profile_store::ProfileStore;
use crate::secret::SecretStore;
use crate::serial::SerialSessionManager;
use crate::session::SessionManager;
use crate::settings::SettingsStore;
use crate::store::DeviceStore;

pub struct AppState {
    pub device_store: DeviceStore,
    /// Saved workspace layouts (SPEC.md §4). Device deletion nulls the deleted
    /// device out of any profile pane referencing it (`clear_device`).
    pub profile_store: ProfileStore,
    /// App settings (SPEC.md §4): terminal appearance + last-used grid.
    pub settings_store: SettingsStore,
    /// Behind an `Arc` (not a `Box`) so the async SSH commands can clone a
    /// `'static` handle to move the blocking keyring lookup onto
    /// `tokio::task::spawn_blocking` without holding a borrow of managed state
    /// across the `.await`.
    pub secret_store: Arc<dyn SecretStore>,
    /// Owns the live SSH sessions (SPEC.md §3). Behind an `Arc` because
    /// `spawn_session` needs an owned handle to move into each session task.
    pub session_manager: Arc<SessionManager>,
    /// Owns the live serial/COM sessions — the serial analogue of
    /// `session_manager`. A session id belongs to exactly one of the two
    /// managers; the command layer routes write/resize/disconnect by ownership.
    pub serial_manager: Arc<SerialSessionManager>,
}
