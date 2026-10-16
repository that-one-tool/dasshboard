/** DOM-free rules for tunnels and their forwards: which devices can tunnel,
 * each forward's state, what to run at launch, and which edits matter. */

import type { Device, Forward, ForwardStatus, SshDevice, TunnelStatus } from "../ipc";
import { t } from "../i18n";
import type { MessageKey } from "../i18n/en";

/** Per-device tunnel state the panel tracks between renders. */
export interface DeviceTunnelState {
  tunnelId: string;
  status: TunnelStatus;
  /** The forwards the user wants bound on this tunnel (empty once stopping). */
  requested: Set<string>;
  /** Per-forward bind state as last reported by the backend. */
  forwards: ForwardStatus[];
}

/** A device's remembered run state: the listed forward ids, none (`false`), or
 * — only in files written before per-forward Start/Stop — all (`true`). */
export type TunnelRunChoice = boolean | string[];

/** deviceId → which of its forwards the user last left running (persisted in
 * `workspace_state.json`). */
export type TunnelRunState = Record<string, TunnelRunChoice>;

/** A forward's status dot: gray, yellow, green, or red (port in use). */
export type ForwardState = "stopped" | "connecting" | "listening" | "unbound";

/** The SSH devices that have at least one forward — the only tunnelable ones. */
export function tunnelableDevices(devices: Device[]): SshDevice[] {
  return devices.filter(
    (d): d is SshDevice => d.kind === "ssh" && d.forwards.length > 0,
  );
}

const STATUS_LABEL_KEYS: Record<TunnelStatus | "stopped", MessageKey> = {
  connecting: "tunnels.status.connecting",
  listening: "tunnels.status.listening",
  error: "tunnels.status.error",
  disconnected: "tunnels.status.stopped",
  stopped: "tunnels.status.stopped",
};

/** Human label for a tunnel's status (or the idle "stopped" state). */
export function statusLabel(status: TunnelStatus | "stopped"): string {
  return t(STATUS_LABEL_KEYS[status]);
}

/**
 * Where one forward stands: not asked for (stopped), asked for but not yet
 * reported by the backend (connecting), or reported bound / not bound.
 */
export function forwardState(
  state: DeviceTunnelState | undefined,
  forwardId: string,
): ForwardState {
  if (!state?.requested.has(forwardId)) return "stopped";
  return getReportedState(state.forwards.find((f) => f.forwardId === forwardId));
}

function getReportedState(live: ForwardStatus | undefined): ForwardState {
  if (!live) return "connecting";
  return live.bound ? "listening" : "unbound";
}

/** How many forwards are bound and listening (green dots), across devices. */
export function listeningForwardCount(states: Iterable<DeviceTunnelState>): number {
  let count = 0;
  for (const state of states) {
    count += [...state.requested].filter((id) => forwardState(state, id) === "listening").length;
  }
  return count;
}

/** The forwards to start at launch for a remembered choice (absent: the
 * device's auto-start flag), limited to forwards the device still has. */
export function forwardIdsToRun(
  device: SshDevice,
  choice: TunnelRunChoice | undefined,
): string[] {
  const all = device.forwards.map((f) => f.id);
  const wanted = choice ?? device.tunnelAutoStart;
  return typeof wanted === "boolean" ? pickAllOrNone(all, wanted) : all.filter((id) => wanted.includes(id));
}

function pickAllOrNone(ids: string[], all: boolean): string[] {
  return all ? ids : [];
}

/** The choice to remember for a set of running forwards: their ids (so a
 * forward added to the device later is not started for the user), or `false`. */
export function runChoiceOf(device: SshDevice, running: Set<string>): TunnelRunChoice {
  const ids = runningInOrder(device, running);
  return ids.length > 0 ? ids : false;
}

/** The device's forward ids that are in `running`, in the device's order. */
export function runningInOrder(device: SshDevice, running: Set<string>): string[] {
  return device.forwards.map((f) => f.id).filter((id) => running.has(id));
}

/** Whether the edit changed what a tunnel's SSH connection depends on, which
 * restarts it. (A new password needs no restart — the open connection already
 * authenticated — and the frontend never sees it anyway.) */
export function isConnectionChanged(before: SshDevice, after: SshDevice): boolean {
  return connectionKey(before) !== connectionKey(after);
}

function connectionKey(device: SshDevice): string {
  const { host, port, username, auth, proxyJump } = device;
  return JSON.stringify([host, port, username, auth, proxyJump]);
}

/** Whether forward `id` exists in both versions of a device but was edited. */
export function isForwardEdited(before: SshDevice, after: SshDevice, id: string): boolean {
  const old = before.forwards.find((f) => f.id === id);
  const now = after.forwards.find((f) => f.id === id);
  return old !== undefined && now !== undefined && forwardKey(old) !== forwardKey(now);
}

/** What a bound forward's listener depends on (its name is cosmetic). */
function forwardKey(forward: Forward): string {
  const { kind, localAddr, localPort, remoteHost, remotePort } = forward;
  return JSON.stringify([kind, localAddr, localPort, remoteHost, remotePort]);
}

type ForwardEndpoints = Pick<Forward, "kind" | "localAddr" | "localPort" | "remoteHost" | "remotePort">;

/**
 * `127.0.0.1:5432 → db.internal:5432` for a forward's endpoints,
 * `127.0.0.1:1080 → SOCKS proxy` for a dynamic one, or
 * `127.0.0.1:3000 ← localhost:8080` for a remote one (the server's port
 * leads here).
 */
export function forwardEndpoint(forward: ForwardEndpoints): string {
  const local = `${forward.localAddr}:${forward.localPort}`;
  const server = `${forward.remoteHost}:${forward.remotePort}`;
  if (forward.kind === "remote") return `${local} ← ${server}`;
  const target = forward.kind === "dynamic" ? t("forwards.socksProxy") : server;
  return `${local} → ${target}`;
}

/** The address a client connects to: the local end, or the server's for a
 * remote forward. */
export function copyTarget(forward: ForwardEndpoints): string {
  return forward.kind === "remote"
    ? `${forward.remoteHost}:${forward.remotePort}`
    : `${forward.localAddr}:${forward.localPort}`;
}

/** The device's jump host was removed (deleted): reconnecting would now reach
 * the target directly. */
export function isJumpHostLost(before: SshDevice, after: SshDevice): boolean {
  return !!before.proxyJump && !after.proxyJump;
}
