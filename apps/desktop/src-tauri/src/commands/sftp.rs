//! The Files panel: SFTP connect, browse, transfers, remote file operations,
//! bookmarks. The heavy lifting lives in `crate::sftp`; these commands resolve
//! the device + credentials, adapt the host-key prompt to a Tauri event, and
//! bridge remote reads/writes to the local filesystem.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::device_access::{find_device, keepalive_config, resolve_credentials, resolve_jump_hop};
use super::host_keys::{emit_host_key_prompt_closed, HOST_KEY_PROMPT_EVENT};
use crate::device::{Connection, Device};
use crate::error::AppError;
use crate::sftp::{SftpEntry, SftpParams, SftpSink};
use crate::ssh::prompts::HostKeyPromptPayload;
use crate::state::AppState;

/// Event name for streamed SFTP transfer progress (see `sftp_progress_emitter`).
const SFTP_PROGRESS_EVENT: &str = "sftp_progress";

/// Wire payload of the `sftp_progress` event, `camelCase`. Non-secret — just the
/// device, direction, and byte counts driving the panel's progress bar.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SftpProgressPayload {
    device_id: String,
    /// `"download"` or `"upload"`.
    direction: &'static str,
    transferred: u64,
    /// Total bytes (0 when unknown); `transferred == total` marks completion.
    total: u64,
}

/// Build a throttled progress callback for a transfer: it emits `sftp_progress`
/// at most every ~50 ms, but always emits the final (`transferred == total`)
/// tick so the bar reliably reaches 100 %. Keeps `SftpManager` Tauri-free — the
/// manager just calls this closure with running byte counts.
pub(super) fn sftp_progress_emitter(
    app: AppHandle,
    device_id: String,
    direction: &'static str,
) -> impl Fn(u64, u64) + Send + Sync {
    use std::sync::atomic::{AtomicU64, Ordering};
    let start = std::time::Instant::now();
    let last_ms = AtomicU64::new(0);
    move |transferred, total| {
        let now_ms = start.elapsed().as_millis() as u64;
        let is_final = total > 0 && transferred >= total;
        if is_final || now_ms.saturating_sub(last_ms.load(Ordering::Relaxed)) >= 50 {
            last_ms.store(now_ms, Ordering::Relaxed);
            let _ = app.emit(
                SFTP_PROGRESS_EVENT,
                SftpProgressPayload {
                    device_id: device_id.clone(),
                    direction,
                    transferred,
                    total,
                },
            );
        }
    }
}

/// Production [`SftpSink`]: forwards an SFTP handshake's host-key trust prompt
/// onto the shared `host_key_prompt` event, so the same dialog a shell/tunnel
/// raises handles it. Carries no secret material.
struct TauriSftpSink {
    app: AppHandle,
}

impl SftpSink for TauriSftpSink {
    fn on_host_key_prompt(&self, payload: HostKeyPromptPayload) {
        let _ = self.app.emit(HOST_KEY_PROMPT_EVENT, payload);
    }
    fn on_host_key_prompt_closed(&self, prompt_id: &str) {
        emit_host_key_prompt_closed(&self.app, prompt_id);
    }
}

/// The SSH endpoint (host, port, username) of a device, or an error for a serial
/// device (which has no SFTP). Used by every SFTP command that needs to connect.
fn ssh_endpoint_of(device: &Device) -> Result<(&str, u16, &str), AppError> {
    match &device.connection {
        Connection::Ssh {
            host,
            port,
            username,
            ..
        } => Ok((host, *port, username)),
        _ => Err(AppError::Validation(
            "only SSH devices support SFTP".to_string(),
        )),
    }
}

/// Open an SFTP connection to a device and return the starting directory (the
/// server's default/home). Shares the host-key path, so a first-contact connect
/// can raise a `host_key_prompt` like a live shell. Reconnecting replaces any
/// existing connection for the device.
#[tauri::command]
pub async fn sftp_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    device_id: String,
) -> Result<String, AppError> {
    let device = find_device(&state, &device_id)?;
    let (host, port, username) = ssh_endpoint_of(&device)?;
    let host = host.to_string();
    let username = username.to_string();

    let creds = resolve_credentials(&state, &device).await?;
    let jump = resolve_jump_hop(&state, &device).await?;
    let sink: Arc<dyn SftpSink> = Arc::new(TauriSftpSink { app });
    state
        .sftp_manager
        .connect(
            SftpParams {
                device_id,
                host,
                port,
                username,
                creds,
                keepalive: keepalive_config(&state),
                jump,
            },
            sink,
        )
        .await
}

/// Close a device's SFTP connection. Idempotent (unknown device ⇒ no-op).
#[tauri::command]
pub async fn sftp_disconnect(
    state: State<'_, AppState>,
    device_id: String,
) -> Result<(), AppError> {
    state.sftp_manager.disconnect(&device_id).await;
    // After the connection is gone, so an edit still opening can't register
    // behind this (see `EditManager::register`).
    state.edit_manager.close_device(&device_id);
    Ok(())
}

/// The device ids that currently have a live SFTP connection, so a re-mounted
/// drawer can restore its state.
#[tauri::command]
pub fn sftp_connected_devices(state: State<'_, AppState>) -> Result<Vec<String>, AppError> {
    Ok(state.sftp_manager.connected_devices())
}

/// List one remote directory (directories first, then files, each sorted).
#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    device_id: String,
    path: String,
) -> Result<Vec<SftpEntry>, AppError> {
    state.sftp_manager.list(&device_id, &path).await
}

/// Resolve a remote path to its canonical absolute form (server-side
/// `realpath`). The browser uses it to navigate "up" — `<cwd>/..` — correctly
/// even through symlinks, rather than trimming the string itself.
#[tauri::command]
pub async fn sftp_realpath(
    state: State<'_, AppState>,
    device_id: String,
    path: String,
) -> Result<String, AppError> {
    state.sftp_manager.canonicalize(&device_id, &path).await
}

/// Download a remote file to a local path chosen via the native save dialog.
/// Streams the file chunk-by-chunk straight to local disk (emitting throttled
/// `sftp_progress` events), never buffering the whole file — so an arbitrarily
/// large file transfers in constant memory. Returns the byte count written.
#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    state: State<'_, AppState>,
    device_id: String,
    remote_path: String,
    local_path: String,
) -> Result<u64, AppError> {
    let local_path = Path::new(&local_path);
    crate::sftp::ensure_storable_target(local_path)?;
    let progress = sftp_progress_emitter(app, device_id.clone(), "download");
    state
        .sftp_manager
        .download_to_path(&device_id, &remote_path, local_path, &progress)
        .await
}

/// Upload a local file (chosen via the native open dialog) to a remote path.
/// Streams the file chunk-by-chunk straight from local disk (emitting throttled
/// `sftp_progress` events), never buffering the whole file. Returns the byte
/// count uploaded.
#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    device_id: String,
    local_path: String,
    remote_path: String,
) -> Result<u64, AppError> {
    let progress = sftp_progress_emitter(app, device_id.clone(), "upload");
    state
        .sftp_manager
        .upload_from_path(&device_id, Path::new(&local_path), &remote_path, &progress)
        .await
}

/// First of `<path>`, `<path> (2)`, `<path> (3)`, … that does not already exist —
/// the rename-on-conflict target for a folder download. Runs on a blocking task.
fn fresh_local_path(base: PathBuf) -> PathBuf {
    if !base.exists() {
        return base;
    }
    let s = base.to_string_lossy().into_owned();
    let mut i = 2;
    loop {
        let candidate = PathBuf::from(format!("{s} ({i})"));
        if !candidate.exists() {
            return candidate;
        }
        i += 1;
    }
}

/// Recursively download a remote directory tree into a local directory.
/// `local_path` is the intended target (destination parent + folder name); the
/// `policy` ("overwrite" | "skip" | "rename") decides what happens when it (or a
/// file inside it) already exists — overwrite replaces, skip merges, rename picks
/// a fresh `<name> (N)` so nothing existing is touched. Emits throttled
/// `sftp_progress` events per file.
#[tauri::command]
pub async fn sftp_download_dir(
    app: AppHandle,
    state: State<'_, AppState>,
    device_id: String,
    remote_path: String,
    local_path: String,
    policy: String,
) -> Result<Vec<String>, AppError> {
    let skip = policy == "skip";
    let mut target = PathBuf::from(local_path);
    crate::sftp::ensure_storable_target(&target)?;
    if policy == "rename" {
        let base = target.clone();
        target = tokio::task::spawn_blocking(move || fresh_local_path(base))
            .await
            .map_err(|e| AppError::Io(format!("rename task failed: {e}")))?;
    }
    let progress = sftp_progress_emitter(app, device_id.clone(), "download");
    state
        .sftp_manager
        .download_dir(&device_id, &remote_path, &target, skip, &progress)
        .await
}

/// Recursively upload a local directory tree into the current remote directory.
/// `remote_path` is the intended target; `policy` behaves as for
/// [`sftp_download_dir`] but against the remote side. Returns the relative
/// paths of the entries skipped (names that aren't valid Unicode).
#[tauri::command]
pub async fn sftp_upload_dir(
    app: AppHandle,
    state: State<'_, AppState>,
    device_id: String,
    local_path: String,
    remote_path: String,
    policy: String,
) -> Result<Vec<String>, AppError> {
    let skip = policy == "skip";
    let mut target = remote_path;
    if policy == "rename" {
        let mut i = 2;
        let mut candidate = target.clone();
        while state
            .sftp_manager
            .remote_exists(&device_id, &candidate)
            .await?
        {
            candidate = format!("{target} ({i})");
            i += 1;
        }
        target = candidate;
    }
    // Ensure the top-level remote directory exists (benign if it already does for
    // an overwrite/skip merge; a real failure surfaces on the first file upload).
    let _ = state.sftp_manager.mkdir(&device_id, &target).await;
    let progress = sftp_progress_emitter(app, device_id.clone(), "upload");
    state
        .sftp_manager
        .upload_dir(&device_id, Path::new(&local_path), &target, skip, &progress)
        .await
}

/// Whether a local path exists — the frontend checks this before a folder
/// download to decide whether to prompt for a conflict policy.
#[tauri::command]
pub async fn sftp_local_exists(path: String) -> Result<bool, AppError> {
    tokio::task::spawn_blocking(move || Path::new(&path).exists())
        .await
        .map_err(|e| AppError::Io(format!("stat task failed: {e}")))
}

/// Whether a remote path exists — the frontend checks this before a folder
/// upload to decide whether to prompt for a conflict policy.
#[tauri::command]
pub async fn sftp_exists(
    state: State<'_, AppState>,
    device_id: String,
    path: String,
) -> Result<bool, AppError> {
    state.sftp_manager.remote_exists(&device_id, &path).await
}

/// Request cancellation of the in-flight transfer for a device (if any). The
/// streaming download/upload loop sees the flag on its next chunk and unwinds
/// with `AppError::Cancelled`; a cancelled upload's partial remote file is
/// removed. Idempotent — no active transfer is a no-op.
#[tauri::command]
pub fn sftp_cancel_transfer(state: State<'_, AppState>, device_id: String) -> Result<(), AppError> {
    state.sftp_manager.cancel_transfer(&device_id);
    Ok(())
}

/// Create a remote directory.
#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    device_id: String,
    path: String,
) -> Result<(), AppError> {
    state.sftp_manager.mkdir(&device_id, &path).await
}

/// Rename/move a remote entry.
#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    device_id: String,
    from: String,
    to: String,
) -> Result<(), AppError> {
    state.sftp_manager.rename(&device_id, &from, &to).await
}

/// Remove a remote entry: a file when `isDir` is false; a directory otherwise —
/// recursively (whole tree) when `recursive`, else only if it is already empty.
#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    device_id: String,
    path: String,
    is_dir: bool,
    recursive: bool,
) -> Result<(), AppError> {
    if is_dir {
        if recursive {
            state.sftp_manager.remove_recursive(&device_id, &path).await
        } else {
            state.sftp_manager.remove_dir(&device_id, &path).await
        }
    } else {
        state.sftp_manager.remove_file(&device_id, &path).await
    }
}

/// Change a remote entry's Unix permission bits (chmod). `mode` is the low
/// `0o7777` bits; the server keeps the file-type bits.
#[tauri::command]
pub async fn sftp_chmod(
    state: State<'_, AppState>,
    device_id: String,
    path: String,
    mode: u32,
) -> Result<(), AppError> {
    state.sftp_manager.chmod(&device_id, &path, mode).await
}

/// The saved bookmark paths for a device (empty if none), so the panel can show
/// its jump list on connect.
#[tauri::command]
pub fn sftp_bookmarks(
    state: State<'_, AppState>,
    device_id: String,
) -> Result<Vec<String>, AppError> {
    Ok(state.bookmark_store.list(&device_id))
}

/// Add a remote path to a device's bookmarks (idempotent). Returns the updated list.
#[tauri::command]
pub fn sftp_bookmark_add(
    state: State<'_, AppState>,
    device_id: String,
    path: String,
) -> Result<Vec<String>, AppError> {
    state.bookmark_store.add(&device_id, &path)
}

/// Remove a remote path from a device's bookmarks (no-op if absent). Returns the
/// updated list.
#[tauri::command]
pub fn sftp_bookmark_remove(
    state: State<'_, AppState>,
    device_id: String,
    path: String,
) -> Result<Vec<String>, AppError> {
    state.bookmark_store.remove(&device_id, &path)
}
