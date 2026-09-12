//! Tauri commands for device management (SPEC.md §5). Each `#[tauri::command]`
//! is a thin wrapper around an `*_impl` function that takes `&AppState`
//! directly — the `impl` functions hold all the actual logic and are what
//! the unit tests below exercise, since constructing a real `tauri::State`
//! outside a running app isn't possible.
//!
//! Argument names are `snake_case` in Rust; Tauri's command macro converts
//! them to `camelCase` on the wire by default (e.g. `device_id` here is
//! invoked from the frontend as `{ deviceId: ... }`).

use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::device::{Auth, Connection, Device, Forward};
use crate::error::AppError;
use crate::known_hosts::KnownHostEntry;
use crate::profile::Profile;
use crate::profile_store::ProfileList;
use crate::serial::SerialParams;
use crate::session::{
    AuthCredentials, ConnectParams, HostKeyPromptPayload, SessionSink, SessionStatus,
};
use crate::settings::Settings;
use crate::state::AppState;
use crate::tunnel::{ForwardStatus, TunnelInfo, TunnelParams, TunnelSink, TunnelStatus};

fn list_devices_impl(state: &AppState) -> Vec<Device> {
    state.device_store.list()
}

/// Writes/clears the keyring entry for a save (B2 fix: this runs *before*
/// the device is persisted, so a keyring failure never leaves `devices.json`
/// claiming an auth method with no matching credential — see
/// `save_device_impl`).
///
/// `secret: Some` writes it verbatim. `secret: None` usually means "leave the
/// existing keyring entry untouched" (the common edit case behind SPEC §7's
/// "unchanged" placeholder); but if the auth method just changed, any stored
/// secret belongs to the *old* method — a password is not a key passphrase
/// and vice versa — so it's deleted instead, per SPEC §4's rule that a `key`
/// device with no passphrase has NO secret stored.
fn write_secret_for_save(
    state: &AppState,
    device_id: &str,
    previous_method: Option<&'static str>,
    incoming_method: &'static str,
    secret: Option<String>,
) -> Result<(), AppError> {
    match secret {
        Some(secret) => state.secret_store.set(device_id, &secret),
        None if previous_method.is_some_and(|prev| prev != incoming_method) => {
            state.secret_store.delete(device_id)
        }
        None => Ok(()),
    }
}

fn save_device_impl(
    state: &AppState,
    mut device: Device,
    secret: Option<String>,
) -> Result<Device, AppError> {
    // Assign the id up front (mirrors `DeviceStore::upsert`'s own id
    // assignment, which is then a no-op) so the secret can be written under
    // the device's final id *before* anything is persisted to devices.json.
    if device.id.trim().is_empty() {
        device.id = Uuid::new_v4().to_string();
    }
    device.validate()?;

    // A serial device has NO secret (SPEC §4): never store one, even if the
    // frontend erroneously supplied it. Dropping it here also means the
    // ssh→serial edit path below sees the method change and clears any stale
    // password/passphrase left over from when the device was SSH.
    let secret = if device.is_serial() { None } else { secret };

    // Capture the previously-stored secret "slot" (SSH auth method, or "serial")
    // if this is an edit of an existing device, before anything below changes
    // it, so we can tell whether the slot is changing.
    let previous_method = state
        .device_store
        .list()
        .into_iter()
        .find(|d| d.id == device.id)
        .map(|d| d.secret_method());
    let incoming_method = device.secret_method();

    // B2: write the secret first. If the keyring write fails, we return here
    // and `device_store.upsert` never runs, so a device can never end up on
    // disk claiming an auth method with no matching keyring entry.
    write_secret_for_save(state, &device.id, previous_method, incoming_method, secret)?;

    state.device_store.upsert(device)
}

fn delete_device_impl(state: &AppState, device_id: &str) -> Result<(), AppError> {
    // If the device itself doesn't exist, `delete` returns `NotFound` via
    // `?` and we never reach the cleanup below.
    state.device_store.delete(device_id)?;
    // The device is now gone from devices.json (irreversible), so run BOTH
    // cleanups unconditionally — a failure in one must not skip the other and
    // strand a dangling reference. A missing keyring entry (e.g. a password-less
    // key device, or one never saved with a secret) is not an error (SPEC.md §5).
    let secret_res = state.secret_store.delete(device_id);
    // Referential cleanup (PLAN.md Phase 4 task 4): null this device out of any
    // profile pane that referenced it, so a saved layout never points at a device
    // that no longer exists. Only rewrites profiles.json if a pane referenced it.
    let profile_res = state.profile_store.clear_device(device_id);
    // B4: `secret_res?` below returns first on a double failure, which would
    // otherwise silently discard `profile_res`'s error. Log it so a double
    // cleanup failure isn't invisible (matches the non-fatal `eprintln!`
    // pattern used elsewhere in the stores).
    if let (Err(secret_err), Err(profile_err)) = (&secret_res, &profile_res) {
        eprintln!(
            "[DaSSHboard] delete_device({device_id}): keyring cleanup failed ({secret_err}) AND profile cleanup failed ({profile_err}); only the keyring error is returned to the caller"
        );
    }
    secret_res?;
    profile_res?;
    Ok(())
}

fn list_profiles_impl(state: &AppState) -> ProfileList {
    state.profile_store.list()
}

fn save_profile_impl(state: &AppState, profile: Profile) -> Result<Profile, AppError> {
    state.profile_store.upsert(profile)
}

fn delete_profile_impl(state: &AppState, profile_id: &str) -> Result<(), AppError> {
    state.profile_store.delete(profile_id)
}

fn set_default_profile_impl(state: &AppState, profile_id: Option<String>) -> Result<(), AppError> {
    state.profile_store.set_default(profile_id)
}

fn get_settings_impl(state: &AppState) -> Settings {
    state.settings_store.get()
}

fn save_settings_impl(state: &AppState, settings: Settings) -> Result<Settings, AppError> {
    state.settings_store.save(settings)
}

/// Re-reads every persisted config file (devices, profiles, settings, known
/// hosts) from disk into the in-memory stores, so a second running app instance
/// picks up changes another instance made. Each store caches its file at
/// startup; without this a change in instance A stays invisible to instance B
/// until B restarts. Secrets are unaffected — they are read live from the OS
/// keyring, never cached. The known-hosts store is shared by the SSH session
/// and tunnel managers, so reloading it once refreshes both.
///
/// Infallible: each store's `reload` recovers from a missing or corrupt file
/// exactly like its startup `load`, so there is nothing to report back.
fn reload_config_impl(state: &AppState) {
    state.device_store.reload();
    state.profile_store.reload();
    state.settings_store.reload();
    state.session_manager.known_hosts().reload();
}

/// Never includes secret material — `Device` has no secret field to begin
/// with (SPEC.md §4/§8).
#[tauri::command]
pub fn list_devices(state: State<'_, AppState>) -> Result<Vec<Device>, AppError> {
    Ok(list_devices_impl(&state))
}

/// Upserts by `device.id` (empty id ⇒ create with a new UUID). `secret`
/// present ⇒ written to the keyring under the (possibly new) device id;
/// absent ⇒ any existing secret is left untouched, *except* when the device's
/// auth method changed in this save, in which case the now-stale secret is
/// deleted so no orphaned password/passphrase remains (SPEC.md §4/§5).
#[tauri::command]
pub fn save_device(
    state: State<'_, AppState>,
    device: Device,
    secret: Option<String>,
) -> Result<Device, AppError> {
    save_device_impl(&state, device, secret)
}

/// Deletes the device, its keyring entry (if any), and nulls it out of any
/// profile pane that referenced it (SPEC.md §5, PLAN.md Phase 4 task 4).
#[tauri::command]
pub fn delete_device(state: State<'_, AppState>, device_id: String) -> Result<(), AppError> {
    delete_device_impl(&state, &device_id)
}

/* ============================================================================
 * Profile commands (SPEC.md §5, Phase 4)
 * ============================================================================ */

/// All saved layouts plus the current default id (SPEC.md §5). Profiles hold
/// only device ids, never secrets.
#[tauri::command]
pub fn list_profiles(state: State<'_, AppState>) -> Result<ProfileList, AppError> {
    Ok(list_profiles_impl(&state))
}

/// Upserts a profile by `profile.id` (empty id ⇒ create with a new UUID).
#[tauri::command]
pub fn save_profile(state: State<'_, AppState>, profile: Profile) -> Result<Profile, AppError> {
    save_profile_impl(&state, profile)
}

/// Deletes a profile; clears `defaultProfileId` if it pointed at it (SPEC.md §5).
#[tauri::command]
pub fn delete_profile(state: State<'_, AppState>, profile_id: String) -> Result<(), AppError> {
    delete_profile_impl(&state, &profile_id)
}

/// Sets or clears (`null`) the default profile loaded on app start (SPEC.md §5).
#[tauri::command]
pub fn set_default_profile(
    state: State<'_, AppState>,
    profile_id: Option<String>,
) -> Result<(), AppError> {
    set_default_profile_impl(&state, profile_id)
}

/* ============================================================================
 * Settings commands (SPEC.md §5, Phase 5)
 * ============================================================================ */

/// Current app settings — terminal appearance + last-used grid (SPEC.md §5).
#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<Settings, AppError> {
    Ok(get_settings_impl(&state))
}

/// Persists app settings (sanitized: font size clamped, empty family defaulted)
/// and returns the stored value (SPEC.md §5).
#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<Settings, AppError> {
    save_settings_impl(&state, settings)
}

/// Reloads every persisted config file from disk into memory (multi-instance
/// sync — see [`reload_config_impl`]). Returns `()`; it cannot fail. The
/// frontend invokes this before re-fetching its lists so the list commands
/// serve the freshly-read data rather than the startup cache.
#[tauri::command]
pub fn reload_config(state: State<'_, AppState>) {
    reload_config_impl(&state);
}

/* ============================================================================
 * SSH session commands (SPEC.md §5–6, Phase 2)
 * ============================================================================ */

const SESSION_STATUS_EVENT: &str = "session_status";
const HOST_KEY_PROMPT_EVENT: &str = "host_key_prompt";

/// Wire payload of the `session_status` event (SPEC.md §5), `camelCase`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionStatusPayload {
    session_id: String,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

/// Production [`SessionSink`]: streams terminal bytes over the per-session IPC
/// `Channel` and emits `session_status` / `host_key_prompt` Tauri events. It
/// carries only the session id and non-secret payloads — never a credential.
struct TauriSessionSink {
    app: AppHandle,
    session_id: String,
    /// `Some` for a live session (its per-session data channel); `None` for
    /// `test_connection`, which has no shell and streams no data.
    channel: Option<Channel<InvokeResponseBody>>,
}

impl SessionSink for TauriSessionSink {
    fn on_data(&self, bytes: &[u8]) {
        if let Some(channel) = &self.channel {
            // Verbatim server output (SPEC §3). `InvokeResponseBody::Raw` is
            // delivered to JS as an `ArrayBuffer`, which the frontend wraps in a
            // `Uint8Array` for `terminal.write()`. A send error just means the
            // frontend dropped the channel; the session loop ends on its own.
            let _ = channel.send(InvokeResponseBody::Raw(bytes.to_vec()));
        }
    }

    fn on_status(&self, status: SessionStatus, message: Option<String>) {
        let _ = self.app.emit(
            SESSION_STATUS_EVENT,
            SessionStatusPayload {
                session_id: self.session_id.clone(),
                status: status.as_str(),
                message,
            },
        );
    }

    fn on_host_key_prompt(&self, payload: HostKeyPromptPayload) {
        let _ = self.app.emit(HOST_KEY_PROMPT_EVENT, payload);
    }
}

/// Look up a device by id (SPEC §5 `NotFound` on miss).
fn find_device(state: &AppState, device_id: &str) -> Result<Device, AppError> {
    state
        .device_store
        .list()
        .into_iter()
        .find(|d| d.id == device_id)
        .ok_or_else(|| AppError::NotFound(format!("no device with id {device_id}")))
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
                path: key_path.clone(),
                passphrase: stored,
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
async fn resolve_credentials(
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

/// The SSH `Auth` of a device, or an error for a serial device (which has no
/// credentials). `connect`/`test_connection` only call this on the SSH branch,
/// so the error is a defensive guard, never hit in the normal flow.
fn ssh_auth_of(device: &Device) -> Result<&Auth, AppError> {
    match &device.connection {
        Connection::Ssh { auth, .. } => Ok(auth),
        Connection::Serial { .. } => Err(AppError::Validation(
            "serial devices have no SSH credentials".to_string(),
        )),
    }
}

/// Open a live shell session (SPEC §5). Returns the new `sessionId`; the shell
/// itself is driven on a background task and reports over `on_data` +
/// `session_status`. Async so the command runs on Tauri's tokio runtime, which
/// `spawn_session`'s `tokio::spawn` needs.
#[tauri::command]
pub async fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    device_id: String,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
) -> Result<String, AppError> {
    let device = find_device(&state, &device_id)?;
    let session_id = Uuid::new_v4().to_string();
    let sink: Arc<dyn SessionSink> = Arc::new(TauriSessionSink {
        app,
        session_id: session_id.clone(),
        channel: Some(on_data),
    });
    match &device.connection {
        Connection::Ssh {
            host,
            port,
            username,
            ..
        } => {
            let creds = resolve_credentials(&state, &device).await?;
            state.session_manager.spawn_session(
                session_id.clone(),
                ConnectParams {
                    host: host.clone(),
                    port: *port,
                    username: username.clone(),
                    creds,
                    cols,
                    rows,
                },
                sink,
            );
        }
        Connection::Serial { .. } => {
            state.serial_manager.spawn_session(
                session_id.clone(),
                serial_params_of(&device.connection),
                sink,
            );
        }
    }
    Ok(session_id)
}

/// Build [`SerialParams`] from a `Connection::Serial`. A defensive `expect`
/// covers the impossible SSH case — callers only reach this on the serial
/// branch of a `match`.
fn serial_params_of(connection: &Connection) -> SerialParams {
    match connection {
        Connection::Serial {
            port_name,
            baud_rate,
            data_bits,
            parity,
            stop_bits,
            flow_control,
        } => SerialParams {
            port_name: port_name.clone(),
            baud_rate: *baud_rate,
            data_bits: *data_bits,
            parity: *parity,
            stop_bits: *stop_bits,
            flow_control: *flow_control,
        },
        Connection::Ssh { .. } => unreachable!("serial_params_of called on an SSH connection"),
    }
}

/// Forward keystrokes to a session (SPEC §5). Unknown/closed session ⇒ no-op.
#[tauri::command]
pub async fn write_stdin(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), AppError> {
    let bytes = data.into_bytes();
    // Route to whichever manager owns the session. `owns` locks+releases the
    // map synchronously (no guard held across the `.await`); the `Arc` is cloned
    // out before awaiting. An unknown id is a no-op in either manager.
    if state.session_manager.owns(&session_id) {
        Arc::clone(&state.session_manager)
            .write_stdin(&session_id, bytes)
            .await;
    } else {
        Arc::clone(&state.serial_manager)
            .write_stdin(&session_id, bytes)
            .await;
    }
    Ok(())
}

/// Resize a session's terminal (SPEC §5). Unknown/closed session ⇒ no-op. A
/// serial session has no window size, so its resize is a no-op.
#[tauri::command]
pub async fn resize_pty(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), AppError> {
    if state.session_manager.owns(&session_id) {
        Arc::clone(&state.session_manager)
            .resize_pty(&session_id, cols, rows)
            .await;
    } else {
        state.serial_manager.resize_pty(&session_id, cols, rows);
    }
    Ok(())
}

/// Gracefully disconnect a session (SPEC §5). Idempotent: an unknown
/// `sessionId` is a no-op. Routes to whichever manager owns it.
#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, session_id: String) -> Result<(), AppError> {
    if state.session_manager.owns(&session_id) {
        Arc::clone(&state.session_manager)
            .disconnect(&session_id)
            .await;
    } else {
        Arc::clone(&state.serial_manager)
            .disconnect(&session_id)
            .await;
    }
    Ok(())
}

/// Resolve a pending host-key trust prompt (SPEC §5). Unknown/stale prompt ⇒
/// no-op. A prompt may belong to either a shell session or a tunnel (each
/// manager has its own registry), so the response is fanned out to both; the
/// one that owns the prompt resolves it and the other no-ops.
#[tauri::command]
pub fn respond_host_key(state: State<'_, AppState>, prompt_id: String, accept: bool) {
    state.session_manager.respond_host_key(&prompt_id, accept);
    state.tunnel_manager.respond_host_key(&prompt_id, accept);
}

/// List every trusted host key for the management UI. Fingerprints are public
/// data (not secrets), so this carries no keyring material.
#[tauri::command]
pub fn list_known_hosts(state: State<'_, AppState>) -> Result<Vec<KnownHostEntry>, AppError> {
    Ok(state.session_manager.known_hosts().list())
}

/// Forget a trusted host by its `host:port` id (management UI). Async because
/// the persist is a blocking `write`+`rename` syscall sequence, run on
/// `spawn_blocking` so it never stalls the async runtime. Forgetting an id that
/// no longer exists is not an error (`Ok(())`) — the row the user clicked is
/// simply already gone.
#[tauri::command]
pub async fn forget_host(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    let known_hosts = state.session_manager.known_hosts();
    tokio::task::spawn_blocking(move || known_hosts.forget(&id))
        .await
        .map_err(|e| AppError::Io(format!("forget-host task failed: {e}")))??;
    Ok(())
}

/// Connect + authenticate + close, no shell (SPEC §5). Surfaces the auth
/// outcome as `Ok(())` / `Err(AppError)`. Shares the host-key path, so a
/// first-contact test can raise a `host_key_prompt` like a live connect.
#[tauri::command]
pub async fn test_connection(
    app: AppHandle,
    state: State<'_, AppState>,
    device_id: String,
) -> Result<(), AppError> {
    let device = find_device(&state, &device_id)?;
    match &device.connection {
        Connection::Ssh {
            host,
            port,
            username,
            ..
        } => {
            let creds = resolve_credentials(&state, &device).await?;
            let manager = Arc::clone(&state.session_manager);
            let sink: Arc<dyn SessionSink> = Arc::new(TauriSessionSink {
                app,
                session_id: format!("test-{device_id}"),
                channel: None,
            });
            manager
                .test_connection(host.clone(), *port, username.clone(), creds, sink)
                .await
        }
        // Serial has no auth or host key: "connected" simply means the port
        // opened. No sink is needed (nothing streams).
        Connection::Serial { .. } => {
            state
                .serial_manager
                .test_connection(serial_params_of(&device.connection))
                .await
        }
    }
}

/* ============================================================================
 * Tunnel commands (SPEC tunnels §3)
 * ============================================================================ */

const TUNNEL_STATUS_EVENT: &str = "tunnel_status";

/// Wire payload of the `tunnel_status` event, `camelCase`. `forwards` carries
/// per-forward bind state on a `listening` status and is empty otherwise.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TunnelStatusPayload {
    tunnel_id: String,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    forwards: Vec<ForwardStatus>,
}

/// Production [`TunnelSink`]: emits `tunnel_status` events and reuses the shared
/// `host_key_prompt` event so a tunnel's first-contact trust prompt drives the
/// same dialog a shell session does. Carries only the tunnel id and non-secret
/// payloads — never a credential.
struct TauriTunnelSink {
    app: AppHandle,
    tunnel_id: String,
}

impl TunnelSink for TauriTunnelSink {
    fn on_status(
        &self,
        status: TunnelStatus,
        message: Option<String>,
        forwards: Vec<ForwardStatus>,
    ) {
        let _ = self.app.emit(
            TUNNEL_STATUS_EVENT,
            TunnelStatusPayload {
                tunnel_id: self.tunnel_id.clone(),
                status: status.as_str(),
                message,
                forwards,
            },
        );
    }

    fn on_host_key_prompt(&self, payload: HostKeyPromptPayload) {
        let _ = self.app.emit(HOST_KEY_PROMPT_EVENT, payload);
    }
}

/// The SSH connection details + forwards of a device, or an error if the device
/// is serial (no tunnels) or has no forwards configured (nothing to bind).
fn tunnel_target_of(device: &Device) -> Result<(&str, u16, &str, &[Forward]), AppError> {
    match &device.connection {
        Connection::Ssh {
            host,
            port,
            username,
            forwards,
            ..
        } => {
            if forwards.is_empty() {
                return Err(AppError::Validation(
                    "this device has no port forwards configured".to_string(),
                ));
            }
            Ok((host, *port, username, forwards))
        }
        Connection::Serial { .. } => Err(AppError::Validation(
            "serial devices do not support tunnels".to_string(),
        )),
    }
}

/// Start a tunnel for a device: open one SSH connection and bind a local
/// listener for each of the device's forwards (SPEC tunnels §3). Returns the new
/// `tunnelId`; the tunnel is driven on a background task reporting over
/// `tunnel_status`.
#[tauri::command]
pub async fn start_tunnel(
    app: AppHandle,
    state: State<'_, AppState>,
    device_id: String,
) -> Result<String, AppError> {
    let device = find_device(&state, &device_id)?;
    let (host, port, username, forwards) = tunnel_target_of(&device)?;
    let host = host.to_string();
    let username = username.to_string();
    let forwards = forwards.to_vec();

    let creds = resolve_credentials(&state, &device).await?;
    let tunnel_id = Uuid::new_v4().to_string();
    let sink: Arc<dyn TunnelSink> = Arc::new(TauriTunnelSink {
        app,
        tunnel_id: tunnel_id.clone(),
    });
    state.tunnel_manager.spawn_tunnel(
        tunnel_id.clone(),
        TunnelParams {
            device_id,
            host,
            port,
            username,
            creds,
            forwards,
        },
        sink,
    );
    Ok(tunnel_id)
}

/// Stop a tunnel by id (SPEC tunnels §3), releasing its bound local listeners.
/// Idempotent: an unknown/already-stopped tunnel is a no-op.
#[tauri::command]
pub async fn stop_tunnel(state: State<'_, AppState>, tunnel_id: String) -> Result<(), AppError> {
    state.tunnel_manager.stop_tunnel(&tunnel_id).await;
    Ok(())
}

/// List the live tunnels (SPEC tunnels §3) so a freshly-mounted UI can show
/// what is already running; live per-forward detail arrives via `tunnel_status`.
#[tauri::command]
pub fn list_tunnels(state: State<'_, AppState>) -> Result<Vec<TunnelInfo>, AppError> {
    Ok(state.tunnel_manager.list())
}

/* ============================================================================
 * Diagnostics
 * ============================================================================ */

/// Walking-skeleton IPC command (Phase 0): proves the frontend <-> backend
/// round trip works end to end. Returns the app's semantic version.
#[tauri::command]
pub fn ping() -> String {
    crate::app_version()
}

/* ============================================================================
 * Import/export commands (PLAN-import-export.md). The `*_impl` logic lives in
 * `transfer.rs`; the `path` argument is `camelCase` on the wire.
 * ============================================================================ */

/// Export all devices to `path` (never includes secrets — `Device` has none).
#[tauri::command]
pub fn export_devices(state: State<'_, AppState>, path: String) -> Result<u32, AppError> {
    crate::transfer::export_devices_impl(&state, Path::new(&path))
}

/// Import devices from `path`: validate every item, then upsert by id
/// (all-or-nothing).
#[tauri::command]
pub fn import_devices(state: State<'_, AppState>, path: String) -> Result<u32, AppError> {
    crate::transfer::import_devices_impl(&state, Path::new(&path))
}

/// Export all profiles to `path` (excludes `defaultProfileId`).
#[tauri::command]
pub fn export_profiles(state: State<'_, AppState>, path: String) -> Result<u32, AppError> {
    crate::transfer::export_profiles_impl(&state, Path::new(&path))
}

/// Import profiles from `path`: validate every item, then upsert by id. Leaves
/// `defaultProfileId` untouched.
#[tauri::command]
pub fn import_profiles(state: State<'_, AppState>, path: String) -> Result<u32, AppError> {
    crate::transfer::import_profiles_impl(&state, Path::new(&path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::{Auth, Connection};
    use crate::known_hosts::KnownHostsStore;
    use crate::profile::{Grid, Pane};
    use crate::profile_store::ProfileStore;
    use crate::secret::{FailingSecretStore, InMemorySecretStore};
    use crate::serial::SerialSessionManager;
    use crate::session::SessionManager;
    use crate::settings::SettingsStore;
    use crate::store::DeviceStore;
    use crate::tunnel::TunnelManager;
    use tempfile::tempdir;

    fn test_state(dir: &std::path::Path) -> AppState {
        let known_hosts = Arc::new(KnownHostsStore::load(dir.to_path_buf()));
        let session_manager = Arc::new(SessionManager::with_defaults(known_hosts));
        let tunnel_manager = Arc::new(TunnelManager::with_defaults(session_manager.known_hosts()));
        AppState {
            device_store: DeviceStore::load(dir.to_path_buf()),
            profile_store: ProfileStore::load(dir.to_path_buf()),
            settings_store: SettingsStore::load(dir.to_path_buf()),
            secret_store: Arc::new(InMemorySecretStore::new()),
            session_manager,
            tunnel_manager,
            serial_manager: Arc::new(SerialSessionManager::new()),
        }
    }

    /// Same as `test_state`, but with an injectable `secret_store` — used by
    /// the B2 tests, which need a `SecretStore` that can be told to fail.
    fn test_state_with_secret_store(
        dir: &std::path::Path,
        secret_store: Arc<dyn crate::secret::SecretStore>,
    ) -> AppState {
        let known_hosts = Arc::new(KnownHostsStore::load(dir.to_path_buf()));
        let session_manager = Arc::new(SessionManager::with_defaults(known_hosts));
        let tunnel_manager = Arc::new(TunnelManager::with_defaults(session_manager.known_hosts()));
        AppState {
            device_store: DeviceStore::load(dir.to_path_buf()),
            profile_store: ProfileStore::load(dir.to_path_buf()),
            settings_store: SettingsStore::load(dir.to_path_buf()),
            secret_store,
            session_manager,
            tunnel_manager,
            serial_manager: Arc::new(SerialSessionManager::new()),
        }
    }

    fn sample_device() -> Device {
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
            },
            auto_reconnect: false,
        }
    }

    fn sample_serial_device() -> Device {
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
        }
    }

    /// Overwrite an SSH device's host in place (leaves the rest of the
    /// connection untouched). A no-op on a serial device.
    fn set_ssh_host(device: &mut Device, new_host: &str) {
        if let Connection::Ssh { host, .. } = &mut device.connection {
            *host = new_host.to_string();
        }
    }

    /// Overwrite an SSH device's auth in place.
    fn set_ssh_auth(device: &mut Device, new_auth: Auth) {
        if let Connection::Ssh { auth, .. } = &mut device.connection {
            *auth = new_auth;
        }
    }

    #[test]
    fn save_device_with_secret_writes_it_to_the_secret_store() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());

        let saved = save_device_impl(&state, sample_device(), Some("hunter2".to_string())).unwrap();

        assert_eq!(
            state.secret_store.get(&saved.id).unwrap(),
            Some("hunter2".to_string())
        );
        assert_eq!(list_devices_impl(&state), vec![saved]);
    }

    #[test]
    fn save_device_without_secret_leaves_existing_secret_untouched() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());

        let saved = save_device_impl(&state, sample_device(), Some("hunter2".to_string())).unwrap();

        let mut edited = saved.clone();
        edited.name = "NAS renamed".to_string();
        let saved_again = save_device_impl(&state, edited, None).unwrap();

        assert_eq!(saved_again.name, "NAS renamed");
        assert_eq!(
            state.secret_store.get(&saved_again.id).unwrap(),
            Some("hunter2".to_string()),
            "secret must survive an update that doesn't include one"
        );
    }

    #[test]
    fn save_device_never_returns_secret_material() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let saved = save_device_impl(&state, sample_device(), Some("hunter2".to_string())).unwrap();

        // `Device` has no secret-shaped field at all, so this is really a
        // compile-time guarantee, but assert on the actual serialized
        // payload too, as a regression trip-wire for anyone tempted to add
        // one later.
        let value = serde_json::to_value(&saved).unwrap();
        let dump = value.to_string();
        assert!(!dump.contains("hunter2"));
    }

    #[test]
    fn save_device_validation_failure_does_not_write_a_secret() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let mut invalid = sample_device();
        invalid.name = String::new();

        let err = save_device_impl(&state, invalid, Some("hunter2".to_string())).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        assert!(list_devices_impl(&state).is_empty());
    }

    #[test]
    fn save_device_clears_stale_secret_when_auth_method_changes() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());

        // Start as a password device with a stored password.
        let saved = save_device_impl(&state, sample_device(), Some("hunter2".to_string())).unwrap();
        assert_eq!(
            state.secret_store.get(&saved.id).unwrap(),
            Some("hunter2".to_string())
        );

        // Edit it into a key device with a passphrase-less (unencrypted) key,
        // leaving the secret field empty ⇒ `secret: None`. The old password
        // must not survive as a phantom key passphrase (SPEC §4: a key device
        // with no passphrase has NO secret stored).
        let mut switched = saved.clone();
        set_ssh_auth(
            &mut switched,
            Auth::Key {
                key_path: "C:/Users/x/.ssh/id_ed25519".to_string(),
            },
        );
        let switched = save_device_impl(&state, switched, None).unwrap();

        assert_eq!(
            state.secret_store.get(&switched.id).unwrap(),
            None,
            "the old password must be cleared when the auth method changes"
        );
    }

    #[test]
    fn save_device_same_method_edit_without_secret_keeps_existing_secret() {
        // Guards against the auth-switch fix over-reaching: a same-method edit
        // that supplies no secret must still leave the stored secret intact.
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());

        let saved = save_device_impl(&state, sample_device(), Some("hunter2".to_string())).unwrap();

        let mut edited = saved.clone();
        set_ssh_host(&mut edited, "10.0.0.1"); // still password auth
        let edited = save_device_impl(&state, edited, None).unwrap();

        assert_eq!(
            state.secret_store.get(&edited.id).unwrap(),
            Some("hunter2".to_string()),
            "a same-method edit with no secret must not disturb the keyring"
        );
    }

    #[test]
    fn save_serial_device_never_stores_a_secret() {
        // A serial device has no secret (SPEC §4). Even if a secret is supplied
        // (e.g. a frontend bug), nothing must land in the keyring for its id.
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());

        let saved =
            save_device_impl(&state, sample_serial_device(), Some("nope".to_string())).unwrap();

        assert!(saved.is_serial());
        assert_eq!(state.secret_store.get(&saved.id).unwrap(), None);
    }

    #[test]
    fn switching_ssh_to_serial_clears_the_old_secret() {
        // Editing a password SSH device into a serial one must clear the now-
        // meaningless stored password (the "slot" changed password → serial).
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());

        let saved = save_device_impl(&state, sample_device(), Some("hunter2".to_string())).unwrap();
        assert_eq!(
            state.secret_store.get(&saved.id).unwrap(),
            Some("hunter2".to_string())
        );

        let mut switched = saved.clone();
        switched.connection = Connection::Serial {
            port_name: "COM3".to_string(),
            baud_rate: 9600,
            data_bits: 8,
            parity: crate::device::Parity::None,
            stop_bits: 1,
            flow_control: crate::device::FlowControl::None,
        };
        let switched = save_device_impl(&state, switched, None).unwrap();

        assert!(switched.is_serial());
        assert_eq!(
            state.secret_store.get(&switched.id).unwrap(),
            None,
            "the old password must be cleared when switching to a serial device"
        );
    }

    // -- B2: secret-write failure must not leave an orphaned device -------

    #[test]
    fn save_device_does_not_persist_device_when_secret_write_fails() {
        let dir = tempdir().unwrap();
        let secret_store = Arc::new(FailingSecretStore::new());
        secret_store.fail_next_set();
        let state = test_state_with_secret_store(dir.path(), secret_store);

        let err =
            save_device_impl(&state, sample_device(), Some("hunter2".to_string())).unwrap_err();

        assert!(matches!(err, AppError::Keyring(_)));
        assert!(
            list_devices_impl(&state).is_empty(),
            "a device must not be persisted claiming a credential that failed to write"
        );
    }

    #[test]
    fn save_device_edit_does_not_persist_when_secret_write_fails() {
        // Same as above, but for an edit of an already-saved device: the
        // pre-existing on-disk device must be left exactly as it was.
        let dir = tempdir().unwrap();
        let secret_store = Arc::new(FailingSecretStore::new());
        let state = test_state_with_secret_store(
            dir.path(),
            Arc::clone(&secret_store) as Arc<dyn crate::secret::SecretStore>,
        );
        let saved = save_device_impl(&state, sample_device(), Some("hunter2".to_string())).unwrap();

        let mut edited = saved.clone();
        set_ssh_host(&mut edited, "10.0.0.1");
        secret_store.fail_next_set();

        let err = save_device_impl(&state, edited, Some("newpass".to_string())).unwrap_err();

        assert!(matches!(err, AppError::Keyring(_)));
        assert_eq!(
            list_devices_impl(&state),
            vec![saved],
            "a failed secret write must leave the previously-saved device untouched"
        );
    }

    #[test]
    fn delete_device_removes_device_and_its_secret() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let saved = save_device_impl(&state, sample_device(), Some("hunter2".to_string())).unwrap();

        delete_device_impl(&state, &saved.id).unwrap();

        assert!(list_devices_impl(&state).is_empty());
        assert_eq!(state.secret_store.get(&saved.id).unwrap(), None);
    }

    #[test]
    fn delete_device_unknown_id_is_not_found() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let err = delete_device_impl(&state, "does-not-exist").unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    // -- B4: a double cleanup failure must still return the keyring error --

    #[test]
    fn delete_device_returns_keyring_error_when_secret_delete_fails() {
        // Regression coverage for B4: even when both cleanups are attempted,
        // the caller must still see the (first) keyring error rather than it
        // being swallowed. The profile-cleanup error being dropped in that
        // case is a deliberate, logged trade-off (see the `eprintln!` in
        // `delete_device_impl`), not something a test can assert on stderr,
        // so this test only pins the still-returned error.
        let dir = tempdir().unwrap();
        let secret_store = Arc::new(FailingSecretStore::new());
        secret_store.fail_next_delete();
        let state = test_state_with_secret_store(
            dir.path(),
            Arc::clone(&secret_store) as Arc<dyn crate::secret::SecretStore>,
        );
        let saved = save_device_impl(&state, sample_device(), Some("hunter2".to_string())).unwrap();

        let err = delete_device_impl(&state, &saved.id).unwrap_err();

        assert!(matches!(err, AppError::Keyring(_)));
        // The device itself is still gone — cleanup failures don't resurrect it.
        assert!(list_devices_impl(&state).is_empty());
    }

    #[test]
    fn delete_device_with_no_secret_ever_set_is_not_an_error() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let saved = save_device_impl(&state, sample_device(), None).unwrap();

        assert!(delete_device_impl(&state, &saved.id).is_ok());
    }

    #[tokio::test]
    async fn resolve_credentials_password_uses_stored_secret() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let saved = save_device_impl(&state, sample_device(), Some("hunter2".to_string())).unwrap();

        match resolve_credentials(&state, &saved).await.unwrap() {
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

        match resolve_credentials(&state, &saved).await.unwrap() {
            AuthCredentials::Key { path, passphrase } => {
                assert_eq!(path, "C:/keys/id_ed25519");
                assert_eq!(passphrase, None);
            }
            other => panic!("expected key credentials, got {other:?}"),
        }
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

        match resolve_credentials(&state, &saved).await.unwrap() {
            AuthCredentials::Key { passphrase, .. } => {
                assert_eq!(passphrase, Some("phrase".to_string()));
            }
            other => panic!("expected key credentials, got {other:?}"),
        }
    }

    #[test]
    fn find_device_unknown_id_is_not_found() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let err = find_device(&state, "nope").unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    /* -- profile commands (SPEC.md §5, Phase 4) -------------------------- */

    fn profile_referencing(device_id: &str) -> Profile {
        Profile {
            id: String::new(),
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
        }
    }

    #[test]
    fn deleting_a_device_nulls_it_out_of_referencing_profiles() {
        // The command-level glue: delete_device must drive the profile-store
        // referential cleanup, not just the device/secret stores. (The store's
        // own clear_device logic is unit-tested in profile_store.rs; this
        // proves delete_device_impl actually calls it.)
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let device = save_device_impl(&state, sample_device(), Some("pw".to_string())).unwrap();
        let profile = save_profile_impl(&state, profile_referencing(&device.id)).unwrap();
        assert_eq!(
            state.profile_store.list().profiles[0].panes[0].device_id,
            Some(device.id.clone())
        );

        delete_device_impl(&state, &device.id).unwrap();

        let cleaned = state
            .profile_store
            .list()
            .profiles
            .into_iter()
            .find(|p| p.id == profile.id)
            .unwrap();
        assert_eq!(
            cleaned.panes[0].device_id, None,
            "the deleted device must be nulled out of the profile pane"
        );
    }

    #[test]
    fn profile_command_impls_round_trip_and_handle_default() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        assert!(list_profiles_impl(&state).profiles.is_empty());

        let saved = save_profile_impl(&state, profile_referencing("dev-1")).unwrap();
        set_default_profile_impl(&state, Some(saved.id.clone())).unwrap();
        let listed = list_profiles_impl(&state);
        assert_eq!(listed.profiles.len(), 1);
        assert_eq!(listed.default_profile_id, Some(saved.id.clone()));

        // Deleting the default profile clears the default (SPEC §5).
        delete_profile_impl(&state, &saved.id).unwrap();
        let after = list_profiles_impl(&state);
        assert!(after.profiles.is_empty());
        assert_eq!(after.default_profile_id, None);
    }

    #[test]
    fn reload_config_refreshes_every_store_from_disk() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());

        // This instance starts empty across all stores.
        assert!(list_devices_impl(&state).is_empty());
        assert!(list_profiles_impl(&state).profiles.is_empty());
        assert_eq!(state.session_manager.known_hosts().list().len(), 0);

        // A second instance (same config dir) writes to each config file.
        let other = test_state(dir.path());
        save_device_impl(&other, sample_device(), Some("pw".to_string())).unwrap();
        save_profile_impl(&other, profile_referencing("dev-1")).unwrap();
        other
            .session_manager
            .known_hosts()
            .trust(
                "h",
                22,
                crate::known_hosts::KnownHost {
                    key_type: "ssh-ed25519".to_string(),
                    fingerprint: "SHA256:abc".to_string(),
                },
            )
            .unwrap();

        // Our in-memory view is stale until reloaded.
        assert!(list_devices_impl(&state).is_empty(), "stale until reload");

        reload_config_impl(&state);

        assert_eq!(list_devices_impl(&state).len(), 1);
        assert_eq!(list_profiles_impl(&state).profiles.len(), 1);
        assert_eq!(state.session_manager.known_hosts().list().len(), 1);
    }
}
