//! Port-forward tunnels: start/stop a tunnel or one forward, list the live ones.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::client_ids::{client_chosen_id, id_in_use};
use super::device_access::{find_device, keepalive_config, resolve_credentials, resolve_jump_hop};
use super::host_keys::{emit_host_key_prompt_closed, HOST_KEY_PROMPT_EVENT};
use crate::device::{Connection, Device, Forward};
use crate::error::AppError;
use crate::ssh::prompts::HostKeyPromptPayload;
use crate::state::AppState;
use crate::tunnel::{ForwardStatus, TunnelInfo, TunnelParams, TunnelSink, TunnelStatus};

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
    /// The `AppError` code of an `error` status (absent otherwise), so the
    /// frontend can tell a drop worth reconnecting from a final failure.
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'static str>,
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

impl TauriTunnelSink {
    fn emit_status(
        &self,
        status: TunnelStatus,
        message: Option<String>,
        code: Option<&'static str>,
        forwards: Vec<ForwardStatus>,
    ) {
        let _ = self.app.emit(
            TUNNEL_STATUS_EVENT,
            TunnelStatusPayload {
                tunnel_id: self.tunnel_id.clone(),
                status: status.as_str(),
                message,
                code,
                forwards,
            },
        );
    }
}

impl TunnelSink for TauriTunnelSink {
    fn on_status(
        &self,
        status: TunnelStatus,
        message: Option<String>,
        forwards: Vec<ForwardStatus>,
    ) {
        self.emit_status(status, message, None, forwards);
    }

    fn on_error(&self, err: &AppError) {
        self.emit_status(
            TunnelStatus::Error,
            Some(err.to_string()),
            Some(err.code()),
            Vec::new(),
        );
    }

    fn on_host_key_prompt(&self, payload: HostKeyPromptPayload) {
        let _ = self.app.emit(HOST_KEY_PROMPT_EVENT, payload);
    }
    fn on_host_key_prompt_closed(&self, prompt_id: &str) {
        emit_host_key_prompt_closed(&self.app, prompt_id);
    }
}

/// The SSH connection details + forwards of a device, or an error if the device
/// is serial (no tunnels) or has no forwards configured (nothing to bind).
fn tunnel_target_of(device: &Device) -> Result<(&str, u16, &str, &[Forward]), AppError> {
    // Stores load without validating, so a hand-edited devices.json (e.g. a
    // forward bound to 0.0.0.0) is caught here with a clear message.
    device.validate()?;
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
        _ => Err(AppError::Validation(
            "only SSH devices support tunnels".to_string(),
        )),
    }
}

/// The device's forwards named in `ids` (in the device's order); an error when
/// none of them exists (e.g. deleted from the device meanwhile).
fn selected_forwards(forwards: &[Forward], ids: &[String]) -> Result<Vec<Forward>, AppError> {
    let selected: Vec<Forward> = forwards
        .iter()
        .filter(|f| ids.contains(&f.id))
        .cloned()
        .collect();
    if selected.is_empty() {
        return Err(AppError::Validation(
            "the requested port forward no longer exists on this device".to_string(),
        ));
    }
    Ok(selected)
}

/// Start a tunnel for a device: open one SSH connection and bind a local
/// listener for each of the device's forwards listed in `forward_ids` (SPEC
/// tunnels §3). Returns the new `tunnelId`; the tunnel is driven on a
/// background task reporting over `tunnel_status`.
#[tauri::command]
pub async fn start_tunnel(
    app: AppHandle,
    state: State<'_, AppState>,
    tunnel_id: String,
    device_id: String,
    forward_ids: Vec<String>,
) -> Result<String, AppError> {
    let tunnel_id = client_chosen_id(tunnel_id, |id| id_in_use(&state, id))?;
    let device = find_device(&state, &device_id)?;
    let (host, port, username, forwards) = tunnel_target_of(&device)?;
    let host = host.to_string();
    let username = username.to_string();
    let forwards = selected_forwards(forwards, &forward_ids)?;

    let creds = resolve_credentials(&state, &device).await?;
    let jump = resolve_jump_hop(&state, &device).await?;
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
            keepalive: keepalive_config(&state),
            jump,
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

/// Bind one more of the device's forwards on a live tunnel's SSH connection;
/// the result arrives as a new `listening` `tunnel_status`.
#[tauri::command]
pub async fn start_tunnel_forward(
    state: State<'_, AppState>,
    tunnel_id: String,
    forward_id: String,
) -> Result<(), AppError> {
    let not_running = || AppError::Validation("this tunnel is no longer running".to_string());
    let device_id = state
        .tunnel_manager
        .device_of(&tunnel_id)
        .ok_or_else(not_running)?;
    let device = find_device(&state, &device_id)?;
    let (_, _, _, forwards) = tunnel_target_of(&device)?;
    let forward = selected_forwards(forwards, &[forward_id])?.remove(0);
    if !state.tunnel_manager.add_forward(&tunnel_id, forward).await {
        return Err(not_running());
    }
    Ok(())
}

/// Release one forward of a live tunnel; releasing its last bound forward ends
/// the tunnel. Idempotent: an unknown tunnel or forward is a no-op.
#[tauri::command]
pub async fn stop_tunnel_forward(
    state: State<'_, AppState>,
    tunnel_id: String,
    forward_id: String,
) -> Result<(), AppError> {
    state
        .tunnel_manager
        .remove_forward(&tunnel_id, forward_id)
        .await;
    Ok(())
}

/// List the live tunnels (SPEC tunnels §3) so a freshly-mounted UI can show
/// what is already running; live per-forward detail arrives via `tunnel_status`.
#[tauri::command]
pub fn list_tunnels(state: State<'_, AppState>) -> Result<Vec<TunnelInfo>, AppError> {
    Ok(state.tunnel_manager.list())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::*;

    #[test]
    fn tunnel_status_payload_carries_the_error_code_only_when_set() {
        let payload = |code| TunnelStatusPayload {
            tunnel_id: "t1".to_string(),
            status: "error",
            message: Some("authentication failed".to_string()),
            code,
            forwards: Vec::new(),
        };
        let with_code = serde_json::to_value(payload(Some("SshAuth"))).unwrap();
        assert_eq!(with_code["code"], "SshAuth");
        assert_eq!(with_code["tunnelId"], "t1");
        let without = serde_json::to_value(payload(None)).unwrap();
        assert!(without.get("code").is_none());
    }

    #[test]
    fn tunnel_target_accepts_a_valid_device() {
        assert!(tunnel_target_of(&device_with_forward("127.0.0.1")).is_ok());
    }

    #[test]
    fn tunnel_target_revalidates_a_device_edited_on_disk() {
        // devices.json is loaded without validation, so a hand-edited
        // non-loopback forward must be refused when the tunnel starts.
        let device = device_with_forward("0.0.0.0");
        let err = tunnel_target_of(&device).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn selected_forwards_keeps_only_the_requested_existing_ones() {
        let device = device_with_forward("127.0.0.1");
        let (_, _, _, forwards) = tunnel_target_of(&device).unwrap();
        let ids = ["gone".to_string(), "f1".to_string()];
        let selected = selected_forwards(forwards, &ids).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].id, "f1");
        let err = selected_forwards(forwards, &["gone".to_string()]).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }
}
