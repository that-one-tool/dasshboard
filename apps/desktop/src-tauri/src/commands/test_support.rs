//! Fixtures shared by the command modules' tests.

use std::sync::Arc;

use crate::device::{Auth, Connection, Device, Forward};
use crate::known_hosts::KnownHostsStore;
use crate::profile::{Grid, Pane, Profile, ProfileTab};
use crate::profile_store::ProfileStore;
use crate::secret::InMemorySecretStore;
use crate::serial::SerialSessionManager;
use crate::session::SessionManager;
use crate::settings::SettingsStore;
use crate::sftp::SftpManager;
use crate::state::AppState;
use crate::store::DeviceStore;
use crate::tunnel::TunnelManager;

pub(super) fn test_state(dir: &std::path::Path) -> AppState {
    let known_hosts = Arc::new(KnownHostsStore::load(dir.to_path_buf()));
    let session_manager = Arc::new(SessionManager::with_defaults(known_hosts));
    let tunnel_manager = Arc::new(TunnelManager::with_defaults(session_manager.known_hosts()));
    let sftp_manager = Arc::new(SftpManager::with_defaults(session_manager.known_hosts()));
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
    }
}

/// Same as `test_state`, but with an injectable `secret_store` — used by
/// the B2 tests, which need a `SecretStore` that can be told to fail.
pub(super) fn test_state_with_secret_store(
    dir: &std::path::Path,
    secret_store: Arc<dyn crate::secret::SecretStore>,
) -> AppState {
    let known_hosts = Arc::new(KnownHostsStore::load(dir.to_path_buf()));
    let session_manager = Arc::new(SessionManager::with_defaults(known_hosts));
    let tunnel_manager = Arc::new(TunnelManager::with_defaults(session_manager.known_hosts()));
    let sftp_manager = Arc::new(SftpManager::with_defaults(session_manager.known_hosts()));
    AppState {
        device_store: DeviceStore::load(dir.to_path_buf()),
        profile_store: ProfileStore::load(dir.to_path_buf()),
        settings_store: SettingsStore::load(dir.to_path_buf()),
        workspace_store: crate::workspace_store::WorkspaceStore::load(dir.to_path_buf()),
        secret_store,
        session_manager,
        tunnel_manager,
        sftp_manager,
        edit_manager: crate::sftp_edit::EditManager::new(dir.join("sftp-edit")),
        serial_manager: Arc::new(SerialSessionManager::new()),
        local_shell_manager: Arc::new(crate::local_shell::LocalShellManager::new()),
        bookmark_store: crate::bookmark_store::BookmarkStore::load(dir.to_path_buf()),
    }
}

pub(super) fn sample_device() -> Device {
    Device {
        id: String::new(),
        name: "NAS".to_string(),
        connection: Connection::Ssh {
            host: "192.168.1.10".to_string(),
            port: 22,
            username: "admin".to_string(),
            auth: Auth::Password,
            forwards: Vec::new(),
            tunnel_auto_start: false,
            forward_agent: false,
            proxy_jump: None,
        },
        auto_reconnect: false,
        tags: Vec::new(),
        connect_snippet: None,
    }
}

pub(super) fn device_with_forward(local_addr: &str) -> Device {
    let mut device = Device {
        id: "11111111-1111-4111-8111-111111111111".to_string(),
        ..sample_device()
    };
    if let Connection::Ssh { forwards, .. } = &mut device.connection {
        forwards.push(Forward {
            id: "f1".to_string(),
            name: "Proxy".to_string(),
            kind: crate::device::ForwardKind::Dynamic,
            local_addr: local_addr.to_string(),
            local_port: 1080,
            remote_host: String::new(),
            remote_port: 0,
        });
    }
    device
}

pub(super) fn sample_serial_device() -> Device {
    Device {
        id: String::new(),
        name: "Arduino".to_string(),
        connection: Connection::Serial {
            port_name: "COM3".to_string(),
            baud_rate: 115200,
            data_bits: 8,
            parity: crate::device::Parity::None,
            stop_bits: 1,
            flow_control: crate::device::FlowControl::None,
        },
        auto_reconnect: false,
        tags: Vec::new(),
        connect_snippet: None,
    }
}

/// Overwrite an SSH device's host in place (leaves the rest of the
/// connection untouched). A no-op on a serial device.
pub(super) fn set_ssh_host(device: &mut Device, new_host: &str) {
    if let Connection::Ssh { host, .. } = &mut device.connection {
        *host = new_host.to_string();
    }
}

/// Overwrite an SSH device's auth in place.
pub(super) fn set_ssh_auth(device: &mut Device, new_auth: Auth) {
    if let Connection::Ssh { auth, .. } = &mut device.connection {
        *auth = new_auth;
    }
}

pub(super) fn profile_referencing(device_id: &str) -> Profile {
    Profile {
        id: String::new(),
        name: "Homelab".to_string(),
        tabs: vec![ProfileTab {
            name: "Homelab".to_string(),
            grid: Grid {
                rows: 1,
                cols: 2,
                row_sizes: vec![1.0],
                col_sizes: vec![0.5, 0.5],
            },
            panes: vec![
                Pane {
                    device_id: Some(device_id.to_string()),
                },
                Pane { device_id: None },
            ],
        }],
    }
}
