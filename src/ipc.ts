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
  | "TunnelBind";

export interface AppError {
  code: ErrorCode;
  message: string;
}

/* ============================================================================
 * IPC command wrappers
 * ============================================================================ */

/** Calls the `ping` command, which returns the backend's app version string. */
export async function ping(): Promise<string> {
  return invoke<string>("ping");
}

/**
 * Lists all saved devices. Does not include secrets (they are stored in the keyring only).
 */
export async function listDevices(): Promise<Device[]> {
  try {
    return await invoke<Device[]>("list_devices");
  } catch (err) {
    throw normalizeError(err);
  }
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
  try {
    return await invoke<Device>("save_device", payload);
  } catch (err) {
    throw normalizeError(err);
  }
}

/**
 * Deletes a device and its associated keyring secret.
 */
export async function deleteDevice(deviceId: string): Promise<void> {
  try {
    await invoke<void>("delete_device", { deviceId } as Record<string, unknown>);
  } catch (err) {
    throw normalizeError(err);
  }
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
  try {
    return await invoke<string>("connect", { deviceId, cols, rows, onData });
  } catch (err) {
    throw normalizeError(err);
  }
}

/** Sends keystrokes to a session (SPEC §5). */
export async function writeStdin(
  sessionId: string,
  data: string,
): Promise<void> {
  try {
    await invoke<void>("write_stdin", { sessionId, data });
  } catch (err) {
    throw normalizeError(err);
  }
}

/** Resizes a session's PTY (SPEC §5). */
export async function resizePty(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  try {
    await invoke<void>("resize_pty", { sessionId, cols, rows });
  } catch (err) {
    throw normalizeError(err);
  }
}

/** Gracefully disconnects a session (SPEC §5). Idempotent. */
export async function disconnect(sessionId: string): Promise<void> {
  try {
    await invoke<void>("disconnect", { sessionId });
  } catch (err) {
    throw normalizeError(err);
  }
}

/** Resolves a pending host-key trust prompt (SPEC §5). */
export async function respondHostKey(
  promptId: string,
  accept: boolean,
): Promise<void> {
  try {
    await invoke<void>("respond_host_key", { promptId, accept });
  } catch (err) {
    throw normalizeError(err);
  }
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
  try {
    return await invoke<KnownHostEntry[]>("list_known_hosts");
  } catch (err) {
    throw normalizeError(err);
  }
}

/**
 * Forgets a trusted host by its `host:port` id. Forgetting an id that is
 * already gone is not an error (the backend returns `Ok`); the next connect to
 * that host will TOFU-prompt again.
 */
export async function forgetHost(id: string): Promise<void> {
  try {
    await invoke<void>("forget_host", { id });
  } catch (err) {
    throw normalizeError(err);
  }
}

/** Connect + authenticate + close, no shell (SPEC §5). */
export async function testConnection(deviceId: string): Promise<void> {
  try {
    await invoke<void>("test_connection", { deviceId });
  } catch (err) {
    throw normalizeError(err);
  }
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
  try {
    return await invoke<string>("start_tunnel", { deviceId });
  } catch (err) {
    throw normalizeError(err);
  }
}

/** Stops a tunnel by id, releasing its bound local listeners. Idempotent. */
export async function stopTunnel(tunnelId: string): Promise<void> {
  try {
    await invoke<void>("stop_tunnel", { tunnelId });
  } catch (err) {
    throw normalizeError(err);
  }
}

/** Lists the currently-live tunnels (SPEC tunnels §3). */
export async function listTunnels(): Promise<TunnelInfo[]> {
  try {
    return await invoke<TunnelInfo[]>("list_tunnels");
  } catch (err) {
    throw normalizeError(err);
  }
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
  try {
    return await invoke<ProfileList>("list_profiles");
  } catch (err) {
    throw normalizeError(err);
  }
}

/**
 * Saves or updates a profile (upsert). For a NEW profile pass `profile.id` as
 * `""` and the backend generates a UUIDv4, returning the stored profile.
 */
export async function saveProfile(profile: Profile): Promise<Profile> {
  try {
    return await invoke<Profile>("save_profile", { profile });
  } catch (err) {
    throw normalizeError(err);
  }
}

/** Deletes a profile; the backend clears the default if it pointed here (SPEC §5). */
export async function deleteProfile(profileId: string): Promise<void> {
  try {
    await invoke<void>("delete_profile", { profileId });
  } catch (err) {
    throw normalizeError(err);
  }
}

/** Sets (or clears, with `null`) the default profile loaded on start (SPEC §5). */
export async function setDefaultProfile(profileId: string | null): Promise<void> {
  try {
    await invoke<void>("set_default_profile", { profileId });
  } catch (err) {
    throw normalizeError(err);
  }
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
}

/** Current app settings (SPEC §5). */
export async function getSettings(): Promise<Settings> {
  try {
    return await invoke<Settings>("get_settings");
  } catch (err) {
    throw normalizeError(err);
  }
}

/** Persists app settings (backend clamps font size / defaults empty family). */
export async function saveSettings(settings: Settings): Promise<Settings> {
  try {
    return await invoke<Settings>("save_settings", { settings });
  } catch (err) {
    throw normalizeError(err);
  }
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
  try {
    return await invoke<number>("export_devices", { path });
  } catch (err) {
    throw normalizeError(err);
  }
}

/**
 * Imports devices from the JSON file at `path` (upsert by id, all-or-nothing on
 * validation). Returns the number of devices imported. `path` comes from the
 * native open dialog (`fileDialog`).
 */
export async function importDevices(path: string): Promise<number> {
  try {
    return await invoke<number>("import_devices", { path });
  } catch (err) {
    throw normalizeError(err);
  }
}

/**
 * Exports all profiles to the given path as a self-describing JSON envelope
 * (the per-machine `defaultProfileId` is intentionally excluded). Returns the
 * number of profiles written.
 */
export async function exportProfiles(path: string): Promise<number> {
  try {
    return await invoke<number>("export_profiles", { path });
  } catch (err) {
    throw normalizeError(err);
  }
}

/**
 * Imports profiles from the JSON file at `path` (upsert by id, all-or-nothing on
 * validation; leaves `defaultProfileId` untouched). Returns the number of
 * profiles imported.
 */
export async function importProfiles(path: string): Promise<number> {
  try {
    return await invoke<number>("import_profiles", { path });
  } catch (err) {
    throw normalizeError(err);
  }
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
