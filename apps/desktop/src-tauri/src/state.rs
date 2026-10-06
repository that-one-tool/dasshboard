//! Tauri managed state: the device store, the `SecretStore` impl the app was
//! wired with (real keyring in production, `InMemorySecretStore` in tests),
//! and — starting Phase 2 — the `SessionManager` that owns all live SSH
//! sessions and the host-key trust machinery.

use std::sync::Arc;

use crate::bookmark_store::BookmarkStore;
use crate::local_shell::LocalShellManager;
use crate::profile_store::ProfileStore;
use crate::secret::SecretStore;
use crate::serial::SerialSessionManager;
use crate::session::SessionManager;
use crate::settings::SettingsStore;
use crate::sftp::SftpManager;
use crate::sftp_edit::EditManager;
use crate::store::DeviceStore;
use crate::tunnel::TunnelManager;
use crate::workspace_store::WorkspaceStore;

pub struct AppState {
    pub device_store: DeviceStore,
    /// Saved workspace layouts (SPEC.md §4). Device deletion nulls the deleted
    /// device out of any profile pane referencing it (`clear_device`).
    pub profile_store: ProfileStore,
    /// Per-instance open-tabs layout (Tabs milestone, Phase 3). Persisted to
    /// `workspace_state.json`, restored on launch; NOT part of multi-instance
    /// config sync (one window's tabs must not clobber another's).
    pub workspace_store: WorkspaceStore,
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
    /// Owns the live tunnels (local port-forwarding). Shares the SSH manager's
    /// host-key TOFU store; behind an `Arc` because `spawn_tunnel` moves an owned
    /// handle into each tunnel task.
    pub tunnel_manager: Arc<TunnelManager>,
    /// Owns the live SFTP connections (the Files drawer). Shares the SSH
    /// manager's host-key TOFU store like the tunnel manager, so a trust
    /// decision applies to shells, tunnels and SFTP to the same host alike.
    pub sftp_manager: Arc<SftpManager>,
    /// SFTP files open for editing in an external editor; each rides its
    /// device's SFTP connection and ends with it.
    pub edit_manager: EditManager,
    /// Owns the live serial/COM sessions — the serial analogue of
    /// `session_manager`. A session id belongs to exactly one of the
    /// session managers; the command layer routes write/resize/disconnect by
    /// ownership.
    pub serial_manager: Arc<SerialSessionManager>,
    /// Owns the live local shell sessions (PowerShell/bash/zsh under a PTY) —
    /// the local-terminal analogue of `session_manager`. Routed by ownership like
    /// the serial manager.
    pub local_shell_manager: Arc<LocalShellManager>,
    /// Per-device SFTP bookmarks (saved remote paths). Persisted to
    /// `sftp_bookmarks.json`; a plain data store, not tied to a live connection.
    pub bookmark_store: BookmarkStore,
}

impl AppState {
    /// Whether any shell session, tunnel or SFTP connection is live.
    pub fn has_live_sessions(&self) -> bool {
        self.live_session_count() > 0
    }

    /// Number of live shell sessions, tunnels and SFTP connections — everything
    /// app close would disconnect (shown in the tray menu).
    pub fn live_session_count(&self) -> usize {
        self.session_manager.session_count()
            + self.serial_manager.session_count()
            + self.local_shell_manager.session_count()
            + self.tunnel_manager.tunnel_count()
            + self.sftp_manager.connection_count()
    }

    /// Gracefully closes every live session, tunnel and SFTP connection, so
    /// remotes see a clean SSH disconnect rather than a dropped socket. Shared
    /// by app close and the update install (whose installer exits the process
    /// without a close event). Each manager bounds its own teardown.
    pub async fn shutdown_live_sessions(&self) {
        self.session_manager.disconnect_all().await;
        self.serial_manager.disconnect_all().await;
        self.local_shell_manager.disconnect_all().await;
        // Release every bound local listener.
        self.tunnel_manager.stop_all().await;
        self.edit_manager.close_all();
        self.sftp_manager.disconnect_all().await;
    }
}
