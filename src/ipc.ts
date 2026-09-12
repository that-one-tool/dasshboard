import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { GridModel } from "./gridModel";

/**
 * Typed wrappers around Tauri `invoke` calls.
 *
 * SPEC.md section 10 requires every IPC payload to be defined once here,
 * mirroring the Rust `serde` structs (camelCase on the wire). Phase 0 only
 * exposed `ping`; Phase 1 adds device CRUD commands from SPEC.md section 5.
 */

/* ============================================================================
 * Device types (SPEC section 4)
 * ============================================================================ */

export type AuthMethod = "password" | "key";

export interface AuthPassword {
  method: "password";
}

export interface AuthKey {
  method: "key";
  keyPath: string;
}

export type Auth = AuthPassword | AuthKey;

/** Connection kind discriminator (mirrors the Rust `kind` tag). */
export type DeviceKind = "ssh" | "serial";

/** Serial parity bit. */
export type Parity = "none" | "odd" | "even";
/** Serial flow control. */
export type FlowControl = "none" | "software" | "hardware";

/** Fields shared by both device kinds. */
interface DeviceCommon {
  id: string;
  name: string;
  /** Phase 5: reconnect automatically on an unexpected drop (default false). */
  autoReconnect: boolean;
}

/**
 * One local port-forward (`ssh -L`) on an SSH device: bind `localAddr:localPort`
 * locally and tunnel each connection to `remoteHost:remotePort` as resolved from
 * the SSH server. Mirrors the Rust `Forward`. `localAddr` is always a loopback
 * address (enforced by validation). The backend always emits `forwards` (empty
 * as `[]`), so every SSH device the frontend sees carries the field.
 */
export interface Forward {
  id: string;
  name: string;
  localAddr: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

/** An SSH target (the original device kind). */
export interface SshDevice extends DeviceCommon {
  kind: "ssh";
  host: string;
  port: number;
  username: string;
  auth: Auth;
  /** Configured local port-forwards; `[]` when the device has no tunnels. */
  forwards: Forward[];
  /** Start this device's tunnel automatically on app launch (binds all forwards). */
  tunnelAutoStart: boolean;
}

/**
 * A serial/COM port device (e.g. `COM3` / `/dev/ttyUSB0`). Has no
 * host/username/auth and no keyring secret — only the port + framing params.
 */
export interface SerialDevice extends DeviceCommon {
  kind: "serial";
  portName: string;
  baudRate: number;
  dataBits: number;
  parity: Parity;
  stopBits: number;
  flowControl: FlowControl;
}

/**
 * A saved device: an SSH target or a serial port, discriminated by `kind`
 * (mirrors the Rust `Device` + flattened `Connection` tagged union). A legacy
 * `devices.json` record without `kind` is read back by the backend as `"ssh"`,
 * so every device the frontend sees carries a `kind`.
 */
export type Device = SshDevice | SerialDevice;

/* ============================================================================
 * Error type (SPEC section 5)
 * ============================================================================ */

export type ErrorCode =
  | "NotFound"
  | "Io"
  | "Keyring"
  | "Validation"
  | "SshAuth"
  | "SshConnect"
  | "SshChannel"
  | "HostKeyRejected"
  | "TunnelBind"
  | "Sftp"
  | "Cancelled";

export interface AppError {
  code: ErrorCode;
  message: string;
}

/* ============================================================================
 * IPC command wrappers
 * ============================================================================ */

/** Calls the `ping` command, which returns the backend's app version string. */
export async function ping(): Promise<string> {
  return invokeChecked<string>("ping");
}

/* ----------------------------------------------------------------------------
 * Multi-instance config sync (reload)
 *
 * Each running app instance is a separate process that caches every config
 * file (`devices.json`, `profiles.json`, `settings.json`, `known_hosts.json`)
 * in memory at startup, so a change made by another instance is invisible until
 * a reload. `reloadConfig` tells the backend to re-read those files; a Rust
 * filesystem watcher also emits `config_changed` on any on-disk change so the
 * frontend can reload automatically (see `onConfigChanged`).
 * -------------------------------------------------------------------------- */

/**
 * When THIS window last wrote config, as an epoch-ms deadline. A local write
 * lands on disk and bounces straight back through the file watcher as a
 * `config_changed` event; without this the window would pointlessly reload its
 * own change. Auto-reload consults `isLocalConfigWriteRecent()` to skip that
 * echo; the manual Reload button ignores it and always reloads.
 */
let suppressAutoReloadUntil = 0;

/** How long after a local config write to treat an incoming `config_changed`
 * as our own echo. Comfortably covers the watcher's 300 ms debounce plus the
 * OS delivering the event. */
const LOCAL_WRITE_ECHO_MS = 900;

/** Marks that this window just wrote a config file (called by every config-
 * writing IPC wrapper below on success), arming the echo-suppression window. */
export function markLocalConfigWrite(): void {
  suppressAutoReloadUntil = Date.now() + LOCAL_WRITE_ECHO_MS;
}

/** Whether a `config_changed` event arriving now is most likely the echo of
 * this window's own recent write, and so should not trigger an auto-reload. */
export function isLocalConfigWriteRecent(): boolean {
  return Date.now() < suppressAutoReloadUntil;
}

/* ----------------------------------------------------------------------------
 * invoke helpers
 *
 * Every command wrapper below funnels through one of these two helpers so the
 * `try/catch → normalizeError` shape (and, for writes, the echo-suppression
 * arm) lives in exactly one place instead of being copy-pasted per command.
 * -------------------------------------------------------------------------- */

/**
 * Invokes a backend command, normalizing any rejection to an {@link AppError}.
 * Pass no `args` for a no-argument command — the second `invoke` parameter is
 * then omitted so the wire call is a bare `invoke(cmd)`.
 */
async function invokeChecked<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await (args === undefined ? invoke<T>(cmd) : invoke<T>(cmd, args));
  } catch (err) {
    throw normalizeError(err);
  }
}

/**
 * Like {@link invokeChecked}, but for a command that writes a config file: on
 * success it arms {@link markLocalConfigWrite} so the file-watcher echo of this
 * window's own write doesn't trigger a redundant auto-reload. The mark runs
 * only after the invoke resolves, so a failed write never suppresses a reload.
 */
async function invokeMutation<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const result = await invokeChecked<T>(cmd, args);
  markLocalConfigWrite();
  return result;
}

/**
 * Re-reads every persisted config file into the backend's in-memory stores, so
 * the subsequent list/get commands serve fresh data rather than the startup
 * cache. Infallible on the backend, but wrapped like the others for a uniform
 * error shape if the IPC layer itself rejects.
 */
export async function reloadConfig(): Promise<void> {
  await invokeChecked<void>("reload_config");
}

/**
 * Subscribes to the backend's debounced `config_changed` event (another
 * instance changed a config file on disk). Returns an unlisten function.
 */
export function onConfigChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("config_changed", () => handler());
}

/**
 * Lists all saved devices. Does not include secrets (they are stored in the keyring only).
 */
export async function listDevices(): Promise<Device[]> {
  return invokeChecked<Device[]>("list_devices");
}

/**
 * Saves or updates a device (upsert).
 *
 * For a new device, pass `device.id` as `""` and the backend generates a UUIDv4.
 *
 * The `secret` field (when provided):
 * - `undefined` / omitted: leaves any existing keyring secret untouched
 * - `""` (empty string): explicitly overwrites the keyring secret with an empty value
 * - Any other string: sets the keyring secret to that value
 *
 * Pass the `secret` field only if the user actually typed/changed the password or passphrase;
 * omit it (use `undefined`) when the field was left untouched (editing mode).
 */
export async function saveDevice(
  device: Device,
  secret?: string,
): Promise<Device> {
  const payload: Record<string, unknown> = { device };
  if (secret !== undefined) {
    payload.secret = secret;
  }
  return invokeMutation<Device>("save_device", payload);
}

/**
 * Deletes a device and its associated keyring secret.
 */
export async function deleteDevice(deviceId: string): Promise<void> {
  await invokeMutation<void>("delete_device", { deviceId });
}

/* ============================================================================
 * SSH session types & commands (SPEC section 5–6, Phase 2)
 * ============================================================================ */

export type SessionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

/** Payload of the `session_status` event (SPEC §5). */
export interface SessionStatusEvent {
  sessionId: string;
  status: SessionStatus;
  message?: string;
}

/** Payload of the `host_key_prompt` event (SPEC §5–6). */
export interface HostKeyPromptEvent {
  promptId: string;
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  /** `true` when a *different* key was already trusted for this host (MITM warning). */
  changed: boolean;
}

/**
 * Opens a live SSH shell session (SPEC §5). Returns the new `sessionId`.
 *
 * `onData` is a per-session `Channel`; the backend streams verbatim terminal
 * bytes over it. Tauri delivers `InvokeResponseBody::Raw` to the channel as an
 * `ArrayBuffer`, so the handler wraps each message in a `Uint8Array` before
 * writing it to xterm.js.
 */
export async function connect(
  deviceId: string,
  cols: number,
  rows: number,
  onData: Channel<ArrayBuffer>,
): Promise<string> {
  return invokeChecked<string>("connect", { deviceId, cols, rows, onData });
}

/** Sends keystrokes to a session (SPEC §5). */
export async function writeStdin(
  sessionId: string,
  data: string,
): Promise<void> {
  await invokeChecked<void>("write_stdin", { sessionId, data });
}

/** Resizes a session's PTY (SPEC §5). */
export async function resizePty(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  await invokeChecked<void>("resize_pty", { sessionId, cols, rows });
}

/** Gracefully disconnects a session (SPEC §5). Idempotent. */
export async function disconnect(sessionId: string): Promise<void> {
  await invokeChecked<void>("disconnect", { sessionId });
}

/** Resolves a pending host-key trust prompt (SPEC §5). */
export async function respondHostKey(
  promptId: string,
  accept: boolean,
): Promise<void> {
  await invokeChecked<void>("respond_host_key", { promptId, accept });
  // Accepting a host key writes known_hosts.json; suppress the resulting
  // watcher echo. A reject changes nothing on disk, so nothing to suppress
  // (hence the conditional mark rather than `invokeMutation`).
  if (accept) markLocalConfigWrite();
}

/**
 * One trusted-host row from the known-hosts store (management UI). `id` is the
 * composite `host:port` key — used both as the display label and as the handle
 * passed back to `forgetHost`. Fingerprints are public data, never secrets.
 */
export interface KnownHostEntry {
  id: string;
  keyType: string;
  fingerprint: string;
}

/** Lists every trusted host key, sorted by `id` (`host:port`). */
export async function listKnownHosts(): Promise<KnownHostEntry[]> {
  return invokeChecked<KnownHostEntry[]>("list_known_hosts");
}

/**
 * Forgets a trusted host by its `host:port` id. Forgetting an id that is
 * already gone is not an error (the backend returns `Ok`); the next connect to
 * that host will TOFU-prompt again.
 */
export async function forgetHost(id: string): Promise<void> {
  await invokeMutation<void>("forget_host", { id });
}

/** Connect + authenticate + close, no shell (SPEC §5). */
export async function testConnection(deviceId: string): Promise<void> {
  await invokeChecked<void>("test_connection", { deviceId });
}

/** Constructs a fresh per-session data `Channel<ArrayBuffer>`. */
export function newDataChannel(): Channel<ArrayBuffer> {
  return new Channel<ArrayBuffer>();
}

/** Subscribes to `session_status` events. Returns an unlisten function. */
export function onSessionStatus(
  handler: (event: SessionStatusEvent) => void,
): Promise<UnlistenFn> {
  return listen<SessionStatusEvent>("session_status", (e) => handler(e.payload));
}

/** Subscribes to `host_key_prompt` events. Returns an unlisten function. */
export function onHostKeyPrompt(
  handler: (event: HostKeyPromptEvent) => void,
): Promise<UnlistenFn> {
  return listen<HostKeyPromptEvent>("host_key_prompt", (e) =>
    handler(e.payload),
  );
}

/* ============================================================================
 * Tunnel types & commands (local port-forwarding — SPEC tunnels §3)
 * ============================================================================ */

export type TunnelStatus =
  | "connecting"
  | "listening"
  | "disconnected"
  | "error";

/** Per-forward bind state, carried on a `listening` `tunnel_status` event. */
export interface ForwardStatus {
  forwardId: string;
  localAddr: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  /** `false` means this forward's local port could not be bound (in use). */
  bound: boolean;
}

/** Payload of the `tunnel_status` event. `forwards` is populated on `listening`. */
export interface TunnelStatusEvent {
  tunnelId: string;
  status: TunnelStatus;
  message?: string;
  forwards: ForwardStatus[];
}

/** One live tunnel as returned by `list_tunnels`. */
export interface TunnelInfo {
  tunnelId: string;
  deviceId: string;
}

/**
 * Starts a tunnel for a device: opens one SSH connection and binds a local
 * listener for each of the device's forwards. Returns the new `tunnelId`; live
 * state arrives via `onTunnelStatus`.
 */
export async function startTunnel(deviceId: string): Promise<string> {
  return invokeChecked<string>("start_tunnel", { deviceId });
}

/** Stops a tunnel by id, releasing its bound local listeners. Idempotent. */
export async function stopTunnel(tunnelId: string): Promise<void> {
  await invokeChecked<void>("stop_tunnel", { tunnelId });
}

/** Lists the currently-live tunnels (SPEC tunnels §3). */
export async function listTunnels(): Promise<TunnelInfo[]> {
  return invokeChecked<TunnelInfo[]>("list_tunnels");
}

/** Subscribes to `tunnel_status` events. Returns an unlisten function. */
export function onTunnelStatus(
  handler: (event: TunnelStatusEvent) => void,
): Promise<UnlistenFn> {
  return listen<TunnelStatusEvent>("tunnel_status", (e) => handler(e.payload));
}

/* ============================================================================
 * Profile types & commands (SPEC §4–5, Phase 4)
 * ============================================================================ */

/** A single grid cell in a saved profile. `deviceId: null` is an empty pane. */
export interface ProfilePane {
  deviceId: string | null;
}

/**
 * A saved workspace layout (SPEC §4). `grid` reuses the frontend `GridModel`
 * shape (`{ rows, cols, rowSizes, colSizes }`), which matches the backend's
 * `profile.grid` field exactly. `panes` is row-major, length `rows*cols`.
 */
export interface Profile {
  id: string;
  name: string;
  grid: GridModel;
  panes: ProfilePane[];
}

/** Return shape of `list_profiles` (SPEC §5). */
export interface ProfileList {
  defaultProfileId: string | null;
  profiles: Profile[];
}

/** Lists all saved profiles plus the current default id (SPEC §5). */
export async function listProfiles(): Promise<ProfileList> {
  return invokeChecked<ProfileList>("list_profiles");
}

/**
 * Saves or updates a profile (upsert). For a NEW profile pass `profile.id` as
 * `""` and the backend generates a UUIDv4, returning the stored profile.
 */
export async function saveProfile(profile: Profile): Promise<Profile> {
  return invokeMutation<Profile>("save_profile", { profile });
}

/** Deletes a profile; the backend clears the default if it pointed here (SPEC §5). */
export async function deleteProfile(profileId: string): Promise<void> {
  await invokeMutation<void>("delete_profile", { profileId });
}

/** Sets (or clears, with `null`) the default profile loaded on start (SPEC §5). */
export async function setDefaultProfile(profileId: string | null): Promise<void> {
  await invokeMutation<void>("set_default_profile", { profileId });
}

/* ============================================================================
 * Settings types & commands (SPEC §4–5, Phase 5)
 * ============================================================================ */

export type TerminalTheme = "dark" | "light";

/** Terminal appearance, applied live to every terminal (SPEC §7). */
export interface TerminalSettings {
  fontSize: number;
  fontFamily: string;
  theme: TerminalTheme;
}

/** The whole `settings.json` payload (SPEC §4). */
export interface Settings {
  version: number;
  terminal: TerminalSettings;
  /** Id of the last-used profile, reloaded on start when no default profile is
   * set; null until a profile has been loaded at least once. */
  lastProfileId: string | null;
  /** UI language locale code (e.g. `"en"`, `"fr"`); `null` means "follow the
   * operating system", resolved by the frontend at startup (see `i18n`). */
  language: string | null;
}

/** Current app settings (SPEC §5). */
export async function getSettings(): Promise<Settings> {
  return invokeChecked<Settings>("get_settings");
}

/** Persists app settings (backend clamps font size / defaults empty family). */
export async function saveSettings(settings: Settings): Promise<Settings> {
  return invokeMutation<Settings>("save_settings", { settings });
}

/* ============================================================================
 * Import / export commands (SPEC §5, JSON transfer)
 * ============================================================================ */

/**
 * Exports all devices to the given path as a self-describing JSON envelope
 * (never including secrets — those live in the OS keyring). Returns the number
 * of devices written. `path` comes from the native save dialog (`fileDialog`).
 */
export async function exportDevices(path: string): Promise<number> {
  return invokeChecked<number>("export_devices", { path });
}

/**
 * Imports devices from the JSON file at `path` (upsert by id, all-or-nothing on
 * validation). Returns the number of devices imported. `path` comes from the
 * native open dialog (`fileDialog`).
 */
export async function importDevices(path: string): Promise<number> {
  return invokeMutation<number>("import_devices", { path });
}

/**
 * Exports all profiles to the given path as a self-describing JSON envelope
 * (the per-machine `defaultProfileId` is intentionally excluded). Returns the
 * number of profiles written.
 */
export async function exportProfiles(path: string): Promise<number> {
  return invokeChecked<number>("export_profiles", { path });
}

/**
 * Imports profiles from the JSON file at `path` (upsert by id, all-or-nothing on
 * validation; leaves `defaultProfileId` untouched). Returns the number of
 * profiles imported.
 */
export async function importProfiles(path: string): Promise<number> {
  return invokeMutation<number>("import_profiles", { path });
}

/** Result of an SSH-config import: how many devices were added vs. skipped
 * (a wildcard/`Match`-only block, an entry that produced no valid device, or a
 * duplicate of one already saved). */
export interface SshImportSummary {
  imported: number;
  skipped: number;
}

/**
 * Imports SSH devices from an OpenSSH client config (typically `~/.ssh/config`)
 * at `path`. Best-effort, upsert into the device store: each concrete `Host`
 * block becomes an SSH device; hosts that don't validate or duplicate an
 * existing device are skipped, not fatal. `path` comes from the native open
 * dialog (`pickSshConfigOpenPath`). Returns the imported/skipped counts.
 */
export async function importSshConfig(
  path: string,
): Promise<SshImportSummary> {
  return invokeMutation<SshImportSummary>("import_ssh_config", { path });
}

/* ============================================================================
 * SFTP commands (the Files drawer) — file browse + up/download over SFTP.
 * These operate on a live SSH connection, not on config files, so they use
 * `invokeChecked` (no multi-instance config-echo suppression).
 * ============================================================================ */

/** One remote directory entry from `sftpList`. */
export interface SftpEntry {
  name: string;
  kind: "dir" | "file" | "symlink";
  size: number;
  /** Unix seconds; absent when the server omits it. */
  modified?: number;
}

/**
 * Opens an SFTP connection to a device (reusing the shell connect + host-key
 * path). Returns the starting directory (the server's home). A first-contact
 * host key raises the same `host_key_prompt` a shell connect does.
 */
export async function sftpConnect(deviceId: string): Promise<string> {
  return invokeChecked<string>("sftp_connect", { deviceId });
}

/** Closes a device's SFTP connection (idempotent). */
export async function sftpDisconnect(deviceId: string): Promise<void> {
  await invokeChecked<void>("sftp_disconnect", { deviceId });
}

/** Device ids with a live SFTP connection, so a re-mounted drawer can restore. */
export async function sftpConnectedDevices(): Promise<string[]> {
  return invokeChecked<string[]>("sftp_connected_devices");
}

/** Lists a remote directory (directories first, then files, each sorted). */
export async function sftpList(
  deviceId: string,
  path: string,
): Promise<SftpEntry[]> {
  return invokeChecked<SftpEntry[]>("sftp_list", { deviceId, path });
}

/** Resolves a remote path to its canonical absolute form (`realpath`). */
export async function sftpRealpath(
  deviceId: string,
  path: string,
): Promise<string> {
  return invokeChecked<string>("sftp_realpath", { deviceId, path });
}

/**
 * Downloads a remote file to a local path (from the native save dialog).
 * Returns the byte count written.
 */
export async function sftpDownload(
  deviceId: string,
  remotePath: string,
  localPath: string,
): Promise<number> {
  return invokeChecked<number>("sftp_download", {
    deviceId,
    remotePath,
    localPath,
  });
}

/**
 * Uploads a local file (from the native open dialog) to a remote path. Returns
 * the byte count uploaded.
 */
export async function sftpUpload(
  deviceId: string,
  localPath: string,
  remotePath: string,
): Promise<number> {
  return invokeChecked<number>("sftp_upload", {
    deviceId,
    localPath,
    remotePath,
  });
}

/** Creates a remote directory. */
export async function sftpMkdir(deviceId: string, path: string): Promise<void> {
  await invokeChecked<void>("sftp_mkdir", { deviceId, path });
}

/** Renames/moves a remote entry. */
export async function sftpRename(
  deviceId: string,
  from: string,
  to: string,
): Promise<void> {
  await invokeChecked<void>("sftp_rename", { deviceId, from, to });
}

/** Removes a remote entry — a directory (must be empty) when `isDir`, else a file. */
export async function sftpRemove(
  deviceId: string,
  path: string,
  isDir: boolean,
): Promise<void> {
  await invokeChecked<void>("sftp_remove", { deviceId, path, isDir });
}

/**
 * Requests cancellation of the in-flight transfer for a device (if any). The
 * streaming download/upload rejects with an `AppError` whose code is
 * `"Cancelled"`. Idempotent — no active transfer is a no-op.
 */
export async function sftpCancelTransfer(deviceId: string): Promise<void> {
  await invokeChecked<void>("sftp_cancel_transfer", { deviceId });
}

/** Streamed transfer progress from the `sftp_progress` event. */
export interface SftpProgressEvent {
  deviceId: string;
  direction: "download" | "upload";
  transferred: number;
  /** Total bytes (0 when unknown); `transferred === total` marks completion. */
  total: number;
}

/**
 * Subscribes to `sftp_progress` events emitted (throttled) during an SFTP
 * upload/download. Returns an unlisten function.
 */
export async function onSftpProgress(
  handler: (event: SftpProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<SftpProgressEvent>("sftp_progress", (e) => handler(e.payload));
}

/* ============================================================================
 * Error handling
 * ============================================================================ */

/**
 * Normalizes Tauri invoke errors to our AppError type.
 *
 * When a backend command returns Err(AppError), Tauri will reject the invoke promise
 * with the serialized error object (already in { code, message } shape). We just
 * validate and return it. If the error is a different shape (e.g., Tauri IPC error),
 * we wrap it as a generic "Io" error.
 */
function normalizeError(err: unknown): AppError {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    const e = err as Record<string, unknown>;
    if (typeof e.code === "string" && typeof e.message === "string") {
      return {
        code: e.code as ErrorCode,
        message: e.message,
      };
    }
  }
  return {
    code: "Io",
    message: `${String(err)}`,
  };
}
