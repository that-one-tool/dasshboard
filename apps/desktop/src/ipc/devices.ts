import { invokeChecked, invokeMutation } from "./invoke";

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
