//! Fixtures shared by the SSH-config tests.

use std::sync::Arc;

use super::jump_spec::{JumpHopSpec, JumpSpec};
use crate::device::{Auth, Connection, Device, X11Mode};
use crate::known_hosts::KnownHostsStore;
use crate::profile_store::ProfileStore;
use crate::secret::InMemorySecretStore;
use crate::serial::SerialSessionManager;
use crate::session::SessionManager;
use crate::settings::SettingsStore;
use crate::state::AppState;
use crate::store::DeviceStore;
use crate::tunnel::TunnelManager;

/// Same store stack the `transfer`/`commands` tests use: real temp-dir
/// stores plus an in-memory keyring, no Tauri runtime required.
pub(super) fn test_state(dir: &std::path::Path) -> AppState {
    let known_hosts = Arc::new(KnownHostsStore::load(dir.to_path_buf()));
    let session_manager = Arc::new(SessionManager::with_defaults(known_hosts));
    let tunnel_manager = Arc::new(TunnelManager::with_defaults(session_manager.known_hosts()));
    let sftp_manager = Arc::new(crate::sftp::SftpManager::with_defaults(
        session_manager.known_hosts(),
    ));
    AppState {
        device_store: DeviceStore::load(dir.to_path_buf()),
        profile_store: ProfileStore::load(dir.to_path_buf()),
        settings_store: SettingsStore::load(dir.to_path_buf()),
        workspace_store: crate::workspace_store::WorkspaceStore::load(dir.to_path_buf()),
        secret_store: Arc::new(InMemorySecretStore::new()),
        session_manager,
        tunnel_manager,
        sftp_manager,
        edit_manager: crate::sftp_edit::EditManager::new(dir.join("sftp-edit")),
        serial_manager: Arc::new(SerialSessionManager::new()),
        local_shell_manager: Arc::new(crate::local_shell::LocalShellManager::new()),
        bookmark_store: crate::bookmark_store::BookmarkStore::load(dir.to_path_buf()),
        command_store: crate::command_library::CommandStore::load(dir.to_path_buf()),
    }
}

pub(super) fn hop(host: &str, user: Option<&str>, port: Option<u16>) -> JumpSpec {
    JumpSpec::Hop(JumpHopSpec {
        host: host.to_string(),
        user: user.map(str::to_string),
        port,
    })
}

pub(super) fn named(state: &AppState, name: &str) -> Device {
    state
        .device_store
        .list()
        .into_iter()
        .find(|d| d.name == name)
        .unwrap_or_else(|| panic!("no device named {name}"))
}

/// Build an SSH device with an explicit id/name and connection knobs.
pub(super) fn ssh_device(id: &str, name: &str, connection: Connection) -> Device {
    Device {
        id: id.to_string(),
        name: name.to_string(),
        connection,
        auto_reconnect: false,
        tags: Vec::new(),
        connect_snippet: None,
    }
}

/// A key-auth SSH connection with the given knobs (defaults elsewhere).
pub(super) fn ssh_conn(
    host: &str,
    port: u16,
    user: &str,
    auth: Auth,
    proxy_jump: Option<String>,
    forward_agent: bool,
) -> Connection {
    Connection::Ssh {
        host: host.to_string(),
        port,
        username: user.to_string(),
        auth,
        forwards: Vec::new(),
        tunnel_auto_start: false,
        proxy_jump,
        forward_agent,
        x11_forwarding: X11Mode::Off,
    }
}
