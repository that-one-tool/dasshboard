import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ErrorCode } from "./errors";
import { invokeChecked } from "./invoke";

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
  /** The `AppError` code of an `error` status. */
  code?: ErrorCode;
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
