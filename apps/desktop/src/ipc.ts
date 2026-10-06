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

export type AuthMethod = "password" | "key" | "agent";

export interface AuthPassword {
  method: "password";
}

export interface AuthKey {
  method: "key";
  keyPath: string;
}

/** Authenticate via the local SSH agent (which may be backed by a hardware
 * token). `fingerprint` is the SHA256 fingerprint (`SHA256:…`) of the chosen
 * agent identity; no secret is stored for this method. */
export interface AuthAgent {
  method: "agent";
  fingerprint: string;
}

export type Auth = AuthPassword | AuthKey | AuthAgent;

/** One public key held by the local SSH agent, as returned by
 * {@link listAgentIdentities}. Public data only — never key material. */
export interface AgentIdentityInfo {
  algorithm: string;
  fingerprint: string;
  isSecurityKey: boolean;
  isCertificate: boolean;
  comment: string;
  openssh: string;
}

/** Connection kind discriminator (mirrors the Rust `kind` tag; the local shell
 * kind is `"localShell"`, the camelCase of the Rust `LocalShell` variant). */
export type DeviceKind = "ssh" | "serial" | "localShell";

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
  /**
   * Free-form labels for organizing/filtering the device list (both kinds).
   * The backend always emits `tags` (empty as `[]`), so every device the
   * frontend sees carries the field — mirrors `forwards`/`autoReconnect`.
   */
  tags: string[];
  /**
   * Optional commands run automatically once the session's shell is ready (all
   * kinds). The snippet is typed into the terminal verbatim — each line sent as
   * if the user pressed Enter — to automate a repetitive login routine. The
   * backend always emits the field (as `null` when unset), so every device the
   * frontend sees carries it — mirrors `proxyJump`.
   */
  connectSnippet: string | null;
}

/**
 * How a forward picks its destination: `local` (`ssh -L`) always goes to
 * `remoteHost:remotePort`; `dynamic` (`ssh -D`) is a SOCKS proxy whose client
 * names the target per connection; `remote` (`ssh -R`) is the reverse: the
 * server listens on `remoteHost:remotePort` and each connection is dialed from
 * here to `localAddr:localPort`. `unsupported` is a kind written by a newer
 * version (the backend loads it as such rather than failing, and never binds
 * it). Mirrors the Rust `ForwardKind`.
 */
export type ForwardKind = "local" | "dynamic" | "remote" | "unsupported";

/**
 * One port-forward on an SSH device: `local*` is this machine's end, `remote*`
 * the server's. A `local` forward binds `localAddr:localPort` and tunnels each
 * connection to `remoteHost:remotePort` (resolved from the SSH server); a
 * `dynamic` one carries `""`/`0` there. Both only bind a loopback `localAddr`
 * (enforced by validation). A `remote` one dials `localAddr:localPort`, any
 * host. Mirrors the Rust `Forward`. The backend always emits `forwards` (empty as
 * `[]`) and every forward's `kind`, so both fields are always present.
 */
export interface Forward {
  id: string;
  name: string;
  kind: ForwardKind;
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
  /**
   * Optional jump host (`ProxyJump`): the id of another saved SSH device to
   * connect through first, or `null` for a direct connection. The backend
   * always emits the field (as `null` when absent), so it is always present.
   */
  proxyJump: string | null;
  /**
   * Forward the local SSH agent (`ssh -A`): let programs on the remote host use
   * this machine's SSH keys (e.g. `git push`, a further `ssh` hop) without
   * copying any key to the server. Off by default; the backend always emits the
   * field, so it is always present.
   */
  forwardAgent: boolean;
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
 * A local shell run under a PTY on this machine (PowerShell/bash/zsh). No
 * host/auth and no keyring secret (like serial). Both fields are optional:
 * `shell` `null`/empty ⇒ the OS default shell, `cwd` `null`/empty ⇒ the user's
 * home. The backend always emits both fields (as `null` when unset).
 */
export interface LocalShellDevice extends DeviceCommon {
  kind: "localShell";
  shell: string | null;
  cwd: string | null;
}

/**
 * A saved device: an SSH target, a serial port, or a local shell, discriminated
 * by `kind` (mirrors the Rust `Device` + flattened `Connection` tagged union). A
 * legacy `devices.json` record without `kind` is read back by the backend as
 * `"ssh"`, so every device the frontend sees carries a `kind`.
 */
export type Device = SshDevice | SerialDevice | LocalShellDevice;

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
  | "Cancelled"
  | "Update";

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
  /** Ended by the user, or the connection was lost (auto-reconnect applies). */
  | "disconnected"
  /** The shell ended on its own with exit code 0 (`exit`, `logout`): never
   * auto-reconnected. A failure code or a kill by signal is `disconnected`. */
  | "exited"
  | "error";

/** Payload of the `session_status` event (SPEC §5). */
export interface SessionStatusEvent {
  sessionId: string;
  status: SessionStatus;
  message?: string;
  /** The error's code, on an `error` status (see `isRetryableFailure`). */
  code?: ErrorCode;
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
  sessionId: string,
  deviceId: string,
  cols: number,
  rows: number,
  onData: Channel<ArrayBuffer>,
): Promise<string> {
  return invokeChecked<string>("connect", { sessionId, deviceId, cols, rows, onData });
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

/** Subscribes to `host_key_prompt_closed` events: the backend stopped waiting
 * on a prompt (answered, timed out, or its connection went away). */
export function onHostKeyPromptClosed(
  handler: (promptId: string) => void,
): Promise<UnlistenFn> {
  return listen<{ promptId: string }>("host_key_prompt_closed", (e) =>
    handler(e.payload.promptId),
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
  /** The forwards it serves or, while still connecting, will bind. */
  forwardIds: string[];
  /** Per-forward bind state as last reported (empty while still connecting). */
  forwards: ForwardStatus[];
}

/**
 * Starts a tunnel for a device: opens one SSH connection and binds a local
 * listener for each of the listed forwards. Returns the new `tunnelId`; live
 * state arrives via `onTunnelStatus`.
 */
export async function startTunnel(
  deviceId: string,
  tunnelId: string,
  forwardIds: string[],
): Promise<string> {
  return invokeChecked<string>("start_tunnel", { tunnelId, deviceId, forwardIds });
}

/** Stops a tunnel by id, releasing its bound local listeners. Idempotent. */
export async function stopTunnel(tunnelId: string): Promise<void> {
  await invokeChecked<void>("stop_tunnel", { tunnelId });
}

/** Binds one more forward on a live tunnel's connection; the result arrives
 * as a new `listening` status. */
export async function startTunnelForward(tunnelId: string, forwardId: string): Promise<void> {
  await invokeChecked<void>("start_tunnel_forward", { tunnelId, forwardId });
}

/** Releases one forward of a live tunnel (the last one ends the tunnel). Idempotent. */
export async function stopTunnelForward(tunnelId: string, forwardId: string): Promise<void> {
  await invokeChecked<void>("stop_tunnel_forward", { tunnelId, forwardId });
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
 * One tab of a saved profile (SPEC §4). `grid` reuses the frontend `GridModel`
 * shape (`{ rows, cols, rowSizes, colSizes }`), which matches the backend's
 * `ProfileTab.grid` field exactly. `panes` is row-major, length `rows*cols`.
 */
export interface ProfileTab {
  name: string;
  grid: GridModel;
  panes: ProfilePane[];
}

/** A saved workspace (SPEC §4): its tabs in strip order, at least one. */
export interface Profile {
  id: string;
  name: string;
  tabs: ProfileTab[];
}

/** Return shape of `list_profiles` (SPEC §5). */
export interface ProfileList {
  defaultProfileId: string | null;
  profiles: Profile[];
  /** True on the launch that converted a single-grid (v1) `profiles.json`,
   * until the next write. */
  migratedFromV1: boolean;
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
 * Workspace state (Tabs milestone, Phase 3)
 *
 * Per-instance open-tabs layout, persisted to `workspace_state.json`. Separate
 * from profiles and NOT part of the multi-instance config sync — so these use
 * plain `invokeChecked` (no `markLocalConfigWrite`): the backend deliberately
 * excludes `workspace_state.json` from the config file-watcher.
 * ============================================================================ */

/** One saved tab: display name, grid layout, row-major panes, linked profile. */
export interface WorkspaceTabState {
  name: string;
  grid: GridModel;
  panes: ProfilePane[];
  linkedProfileId: string | null;
}

/** The docked Files (SFTP) panel's per-instance UI state (open/collapsed/width
 * + last-selected device, preselected on restore but not auto-reconnected). */
export interface SftpPanelState {
  open: boolean;
  collapsed: boolean;
  width: number;
  deviceId: string | null;
}

/** The saved open-tabs workspace. Empty `tabs` means nothing persisted yet. */
export interface WorkspaceState {
  tabs: WorkspaceTabState[];
  activeIndex: number;
  /** The Files panel's UI state, or absent/undefined before it has been used. */
  sftp?: SftpPanelState;
  /** The left menu's width in px, or absent while the CSS default applies. */
  sidebarWidth?: number;
  /** True while the left menu is collapsed to its thin bar; absent otherwise. */
  sidebarCollapsed?: boolean;
  /** Device id → which of its forwards the user last left running (explicit
   * Start/Stop): the listed forward ids, or none (`false`); `true` (all) only
   * in older files. Absent devices follow their `tunnelAutoStart` flag. */
  tunnels?: Record<string, boolean | string[]>;
  /** The device list's collapsed tag sections, by lowercased tag (`""` for the
   * untagged one); absent while none are collapsed. */
  collapsedDeviceGroups?: string[];
}

/** The saved workspace, or an empty one (no tabs) on first launch / corrupt file. */
export async function getWorkspaceState(): Promise<WorkspaceState> {
  return invokeChecked<WorkspaceState>("get_workspace_state");
}

/** Persists the open-tabs workspace (validated + atomic on the backend). */
export async function saveWorkspaceState(workspace: WorkspaceState): Promise<void> {
  await invokeChecked<void>("save_workspace_state", { workspace });
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
  /** Lines of scrollback xterm.js retains above the viewport (backend clamps
   * 0..=100000). Applied live to existing terminals and to new ones. */
  scrollback: number;
}

/** SSH keepalive settings (backend clamps interval 0..=3600, count 1..=10). */
export interface KeepaliveSettings {
  /** Seconds between keepalive pings; `0` disables keepalive. */
  intervalSecs: number;
  /** Consecutive unanswered pings before the connection is dropped. */
  countMax: number;
}

/** SFTP browser behavior (backend clamps idle-disconnect 0..=1440). */
export interface SftpSettings {
  /** Minutes an idle (collapsed) SFTP connection lives before it is
   * auto-disconnected; `0` disables the idle timeout. */
  idleDisconnectMins: number;
  /** Command that opens a file for edit-in-place (`{file}` marks the path,
   * else it is appended); empty uses the OS default app. Trimmed by the
   * backend. */
  editorCommand: string;
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
  /** SSH keepalive cadence + dead-peer threshold, applied to shell sessions and
   * tunnels (not serial). */
  keepalive: KeepaliveSettings;
  /** SFTP file-browser behavior (idle-disconnect timeout). */
  sftp: SftpSettings;
  /** Update-check behavior (launch check is opt-in). */
  updates: UpdateSettings;
  /** System-tray behavior (close-to-tray is opt-in). */
  tray: TraySettings;
}

/** Mirrors the backend `TraySettings`. */
export interface TraySettings {
  /** Closing the window hides it to the tray (sessions keep running); off by
   * default. */
  closeToTray: boolean;
}

/** Mirrors the backend `UpdateSettings`. */
export interface UpdateSettings {
  /** Check for a new version once at app start; off by default. */
  checkOnLaunch: boolean;
}

/* ----------------------------------------------------------------------------
 * App updates (backend `updater.rs`)
 * -------------------------------------------------------------------------- */

/** Mirrors the backend `UpdateInfo`: a newer release found by `checkUpdate`. */
export interface UpdateInfo {
  version: string;
  /** Release notes, when the release carries any. */
  notes: string | null;
  /** When the release was published (RFC 3339), when the server says. */
  pubDate: string | null;
  /** Whether this build can install the update itself (Windows, Linux
   * AppImage); `false` for a .deb/.rpm install, which links to the download
   * page instead. */
  canInstall: boolean;
  /** Whether Flatpak delivers the update; the dialog then points the user to
   * their software center instead of the download page. */
  viaFlatpak: boolean;
}

/** Asks the update server for a newer release; `null` when up to date. */
export async function checkUpdate(): Promise<UpdateInfo | null> {
  return invokeChecked<UpdateInfo | null>("check_update");
}

/** Downloads and signature-verifies the confirmed release (`version` guards
 * against a re-check swapping it); live sessions are untouched. */
export async function downloadUpdate(version: string): Promise<void> {
  await invokeChecked<void>("download_update", { version });
}

/** Installs the downloaded release, closing live sessions first, then restarts
 * the app (on success this promise never settles). */
export async function installUpdate(version: string): Promise<void> {
  await invokeChecked<void>("install_update", { version });
}

/** Current app settings (SPEC §5). */
export async function getSettings(): Promise<Settings> {
  return invokeChecked<Settings>("get_settings");
}

/** Persists app settings (backend clamps font size / defaults empty family). */
export async function saveSettings(settings: Settings): Promise<Settings> {
  return invokeMutation<Settings>("save_settings", { settings });
}

/* ----------------------------------------------------------------------------
 * System tray (backend `tray.rs`)
 * -------------------------------------------------------------------------- */

/** Mirrors the backend `TrayLabels`: the tray menu, already translated. */
export interface TrayLabels {
  /** The disabled live-connection count line, pluralized. */
  connections: string;
  show: string;
  quit: string;
}

/** Live shell sessions, tunnels and SFTP connections right now. */
export async function getLiveSessionCount(): Promise<number> {
  return invokeChecked<number>("live_session_count");
}

/** Pushes translated tray menu labels to the backend. */
export async function setTrayLabels(labels: TrayLabels): Promise<void> {
  await invokeChecked<void>("set_tray_labels", { labels });
}

/** Subscribes to `live_session_count` (emitted when the number of live
 * sessions, tunnels and SFTP connections changes). Returns an unlisten function. */
export function onLiveSessionCount(handler: (count: number) => void): Promise<UnlistenFn> {
  return listen<number>("live_session_count", (e) => handler(e.payload));
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

/**
 * Writes `contents` to the text file at `path` (a terminal's saved output;
 * `path` comes from the native save dialog, `pickTextSavePath`).
 */
export async function saveTextFile(path: string, contents: string): Promise<void> {
  return invokeChecked<void>("save_text_file", { path, contents });
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

/** Result of an SSH-config export: how many SSH devices were written vs. how
 * many non-SSH devices (serial / local shell) were skipped. */
export interface SshExportSummary {
  exported: number;
  skipped: number;
}

/**
 * Exports every SSH device to an OpenSSH client config at `path` (the reverse of
 * `importSshConfig`). Non-SSH devices are skipped. Never writes secret material.
 * `path` comes from the native save dialog (`pickSshConfigSavePath`). Returns
 * the exported/skipped counts. Not a config-store write, so no echo suppression.
 */
export async function exportSshConfig(
  path: string,
): Promise<SshExportSummary> {
  return invokeChecked<SshExportSummary>("export_ssh_config", { path });
}

/** Whether a local SSH agent looks reachable, for the device editor's
 * agent-forwarding hint. Best-effort — the toggle stays usable regardless. */
export async function sshAgentAvailable(): Promise<boolean> {
  return invokeChecked<boolean>("ssh_agent_available");
}

/** List the identities held by the local SSH agent, for the device editor's
 * agent-auth picker. Rejects if no agent is reachable; resolves to `[]` when the
 * agent is running but holds no keys. */
export async function listAgentIdentities(): Promise<AgentIdentityInfo[]> {
  return invokeChecked<AgentIdentityInfo[]>("list_agent_identities");
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
  /** Unix permission bits (`0o7777` mask); absent when the server omits mode. */
  mode?: number;
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

/** How a recursive folder transfer resolves a name that already exists at the
 * destination (chosen once per operation): replace, merge-keeping-existing, or
 * write under a fresh `<name> (N)`. */
export type ConflictPolicy = "overwrite" | "skip" | "rename";

/** Recursively downloads a remote directory tree into `localPath` (the target
 * directory), applying `policy` to entries that already exist. Resolves the
 * remote paths it skipped: links to folders, broken links, special files
 * (devices, FIFOs), and names this computer can't store. */
export async function sftpDownloadDir(
  deviceId: string,
  remotePath: string,
  localPath: string,
  policy: ConflictPolicy,
): Promise<string[]> {
  return invokeChecked<string[]>("sftp_download_dir", { deviceId, remotePath, localPath, policy });
}

/** Recursively uploads a local directory tree into `remotePath` (the target
 * directory), applying `policy` to entries that already exist. */
export async function sftpUploadDir(
  deviceId: string,
  localPath: string,
  remotePath: string,
  policy: ConflictPolicy,
): Promise<void> {
  await invokeChecked<void>("sftp_upload_dir", { deviceId, localPath, remotePath, policy });
}

/** Whether a local path exists (to decide whether to prompt for a conflict). */
export async function sftpLocalExists(path: string): Promise<boolean> {
  return invokeChecked<boolean>("sftp_local_exists", { path });
}

/** Whether a remote path exists (to decide whether to prompt for a conflict). */
export async function sftpExists(deviceId: string, path: string): Promise<boolean> {
  return invokeChecked<boolean>("sftp_exists", { deviceId, path });
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

/**
 * Removes a remote entry: a file when `isDir` is false; a directory otherwise —
 * recursively (whole tree) when `recursive`, else only when already empty.
 */
export async function sftpRemove(
  deviceId: string,
  path: string,
  isDir: boolean,
  recursive = false,
): Promise<void> {
  await invokeChecked<void>("sftp_remove", { deviceId, path, isDir, recursive });
}

/** Changes a remote entry's Unix permission bits (chmod). `mode` is the low
 * `0o7777` bits; the server keeps the file-type bits. */
export async function sftpChmod(deviceId: string, path: string, mode: number): Promise<void> {
  await invokeChecked<void>("sftp_chmod", { deviceId, path, mode });
}

/** The saved bookmark paths for a device (in saved order; empty if none). */
export async function sftpBookmarks(deviceId: string): Promise<string[]> {
  return invokeChecked<string[]>("sftp_bookmarks", { deviceId });
}

/** Adds a remote path to a device's bookmarks (idempotent). Returns the list. */
export async function sftpBookmarkAdd(deviceId: string, path: string): Promise<string[]> {
  return invokeChecked<string[]>("sftp_bookmark_add", { deviceId, path });
}

/** Removes a remote path from a device's bookmarks (no-op if absent). Returns the list. */
export async function sftpBookmarkRemove(deviceId: string, path: string): Promise<string[]> {
  return invokeChecked<string[]>("sftp_bookmark_remove", { deviceId, path });
}

/**
 * Requests cancellation of the in-flight transfer for a device (if any). The
 * streaming download/upload rejects with an `AppError` whose code is
 * `"Cancelled"`. Idempotent — no active transfer is a no-op.
 */
export async function sftpCancelTransfer(deviceId: string): Promise<void> {
  await invokeChecked<void>("sftp_cancel_transfer", { deviceId });
}

/** A remote file open for editing in an external editor (`sftp_edit_open`). */
export interface SftpEditInfo {
  editId: string;
  deviceId: string;
  remotePath: string;
  /** Base name of the remote file. */
  name: string;
}

/** Whether a saved edit needs uploading: `unchanged` (same content as the last
 * sync), `clean` (safe to upload), or `conflict` (the remote changed too). */
export type SftpEditCheck = "unchanged" | "clean" | "conflict";

/** What an edit upload did; `conflict` means it was refused (not uploaded). */
export type SftpEditUpload = "uploaded" | "unchanged" | "conflict";

/**
 * Downloads a remote file into a private local copy, watches it, and opens it
 * in the configured editor (or the OS default app). Streams `sftp_progress`
 * like a download.
 */
export async function sftpEditOpen(deviceId: string, remotePath: string): Promise<SftpEditInfo> {
  return invokeChecked<SftpEditInfo>("sftp_edit_open", { deviceId, remotePath });
}

/** The size of the file `path` points to (following a symlink); rejects with
 * a `Validation` error for a folder. Checked before opening it for editing. */
export async function sftpEditableSize(deviceId: string, path: string): Promise<number> {
  return invokeChecked<number>("sftp_editable_size", { deviceId, path });
}

/** Opens an edit's local copy in the editor again. */
export async function sftpEditLaunch(editId: string): Promise<void> {
  await invokeChecked<void>("sftp_edit_launch", { editId });
}

/** Compares an edit's local copy and the remote file against the last sync. */
export async function sftpEditCheck(editId: string): Promise<SftpEditCheck> {
  return invokeChecked<SftpEditCheck>("sftp_edit_check", { editId });
}

/** Uploads an edit's local copy over the remote file; refused with `conflict`
 * when the remote changed, unless `overwrite`. Streams `sftp_progress`. */
export async function sftpEditUpload(editId: string, overwrite: boolean): Promise<SftpEditUpload> {
  return invokeChecked<SftpEditUpload>("sftp_edit_upload", { editId, overwrite });
}

/** Replaces an edit's local copy with the current remote file. */
export async function sftpEditDiscard(editId: string): Promise<void> {
  await invokeChecked<void>("sftp_edit_discard", { editId });
}

/** Ends an edit and deletes its local copy. Unknown ids are a no-op. */
export async function sftpEditClose(editId: string): Promise<void> {
  await invokeChecked<void>("sftp_edit_close", { editId });
}

/** Subscribes to `sftp_edit_changed`: an edit's local copy was saved. */
export async function onSftpEditChanged(handler: (editId: string) => void): Promise<UnlistenFn> {
  return listen<{ editId: string }>("sftp_edit_changed", (e) => handler(e.payload.editId));
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
