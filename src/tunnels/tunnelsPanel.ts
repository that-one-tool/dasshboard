/**
 * The Tunnels sidebar card (SPEC tunnels §6): a section under Devices listing
 * every SSH device that has port forwards with a Start/Stop control, a live
 * status chip, and per-forward `local → remote` rows (with copy-endpoint). It is
 * intentionally separate from the terminal grid — a tunnel has no terminal and
 * is long-lived — so `grid.ts` / `pane.ts` are untouched.
 *
 * Live state comes from `tunnel_status` events (keyed by `tunnelId`); the panel
 * maps those back to devices so each device row reflects its own tunnel.
 */

import {
  listDevices,
  listTunnels,
  onTunnelStatus,
  startTunnel,
  stopTunnel,
  type AppError,
  type Device,
  type ForwardStatus,
  type SshDevice,
  type TunnelStatus,
  type TunnelStatusEvent,
} from "../ipc";
import type { UnlistenFn } from "@tauri-apps/api/event";

/** Per-device tunnel state the panel tracks between renders. */
interface DeviceTunnelState {
  tunnelId: string;
  status: TunnelStatus;
  forwards: ForwardStatus[];
}

export interface TunnelsPanelOptions {
  onError?: (error: AppError) => void;
  onSuccess?: (message: string) => void;
}

/** The SSH devices that have at least one forward — the only tunnelable ones. */
export function tunnelableDevices(devices: Device[]): SshDevice[] {
  return devices.filter(
    (d): d is SshDevice => d.kind === "ssh" && d.forwards.length > 0,
  );
}

/** Human label for a tunnel's status (or the idle "stopped" state). */
export function statusLabel(status: TunnelStatus | "stopped"): string {
  switch (status) {
    case "connecting":
      return "Connecting…";
    case "listening":
      return "Listening";
    case "error":
      return "Error";
    case "disconnected":
    case "stopped":
      return "Stopped";
  }
}

/** `127.0.0.1:5432 → db.internal:5432` for a forward's endpoints. */
export function forwardEndpoint(forward: {
  localAddr: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
}): string {
  return `${forward.localAddr}:${forward.localPort} → ${forward.remoteHost}:${forward.remotePort}`;
}

export class TunnelsPanel {
  private devices: Device[] = [];
  /** deviceId → its live tunnel state (present only while a tunnel runs). */
  private readonly byDevice = new Map<string, DeviceTunnelState>();
  /** tunnelId → deviceId, so a `tunnel_status` event routes to the right row. */
  private readonly deviceByTunnel = new Map<string, string>();
  private unlisten: UnlistenFn | null = null;
  private readonly container: HTMLElement | null;
  private body: HTMLElement | null = null;

  constructor(private readonly options: TunnelsPanelOptions = {}) {
    // The sidebar card container (mirrors how the device/profile managers bind
    // to their `.device-list` / `.profile-list` sections).
    this.container = document.querySelector<HTMLElement>(".tunnel-list");
  }

  async init(): Promise<void> {
    this.buildCard();
    this.devices = await this.safeListDevices();
    await this.adoptRunningTunnels();
    this.subscribe();
    this.render();
    await this.autoStartFlagged();
  }

  /**
   * Start tunnels for devices flagged `tunnelAutoStart` on launch — unless one
   * is already running (adopted above). Sequential so a burst of failures
   * surfaces as individual toasts rather than all at once.
   */
  private async autoStartFlagged(): Promise<void> {
    for (const device of tunnelableDevices(this.devices)) {
      if (device.tunnelAutoStart && !this.byDevice.has(device.id)) {
        await this.handleStart(device.id);
      }
    }
  }

  /** Refresh the device list (called when devices are added/edited/deleted). */
  setDevices(devices: Device[]): void {
    this.devices = devices;
    this.render();
  }

  /** Re-fetch devices from the backend and re-render (device CRUD happened). */
  async refresh(): Promise<void> {
    this.setDevices(await this.safeListDevices());
  }

  /** Stop listening — used by tests; the app keeps the panel for its lifetime. */
  dispose(): void {
    this.unlisten?.();
    this.unlisten = null;
  }

  private async safeListDevices(): Promise<Device[]> {
    try {
      return await listDevices();
    } catch (err) {
      this.options.onError?.(err as AppError);
      return [];
    }
  }

  /** Reflect tunnels already running (e.g. after a UI reload) as listening. */
  private async adoptRunningTunnels(): Promise<void> {
    let running;
    try {
      running = await listTunnels();
    } catch {
      return; // non-fatal: the panel just starts with nothing marked running
    }
    for (const { tunnelId, deviceId } of running) {
      this.deviceByTunnel.set(tunnelId, deviceId);
      this.byDevice.set(deviceId, {
        tunnelId,
        status: "listening",
        forwards: [],
      });
    }
  }

  private subscribe(): void {
    void onTunnelStatus((event) => this.onStatus(event)).then((unlisten) => {
      this.unlisten = unlisten;
    });
  }

  private onStatus(event: TunnelStatusEvent): void {
    const deviceId = this.deviceByTunnel.get(event.tunnelId);
    if (!deviceId) return;

    if (event.status === "disconnected" || event.status === "error") {
      this.byDevice.delete(deviceId);
      this.deviceByTunnel.delete(event.tunnelId);
      if (event.status === "error") {
        this.options.onError?.({
          code: "TunnelBind",
          message: event.message ?? "the tunnel stopped with an error",
        });
      }
    } else {
      this.byDevice.set(deviceId, {
        tunnelId: event.tunnelId,
        status: event.status,
        forwards: event.forwards,
      });
    }
    this.render();
  }

  private async handleStart(deviceId: string): Promise<void> {
    // Optimistically mark connecting so the row reflects the click immediately.
    this.byDevice.set(deviceId, {
      tunnelId: "",
      status: "connecting",
      forwards: [],
    });
    this.render();
    try {
      const tunnelId = await startTunnel(deviceId);
      this.deviceByTunnel.set(tunnelId, deviceId);
      const current = this.byDevice.get(deviceId);
      this.byDevice.set(deviceId, {
        tunnelId,
        status: current?.status ?? "connecting",
        forwards: current?.forwards ?? [],
      });
      this.render();
    } catch (err) {
      this.byDevice.delete(deviceId);
      this.render();
      this.options.onError?.(err as AppError);
    }
  }

  private async handleStop(deviceId: string): Promise<void> {
    const state = this.byDevice.get(deviceId);
    if (!state || state.tunnelId === "") return;
    try {
      await stopTunnel(state.tunnelId);
    } catch (err) {
      this.options.onError?.(err as AppError);
    }
  }

  private async copyEndpoint(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.options.onSuccess?.("Copied to clipboard");
    } catch {
      // Clipboard blocked/unavailable — silent; the text is still on screen.
    }
  }

  /* ----- DOM -------------------------------------------------------------- */

  /** Render the sidebar card shell (header + list body) into `.tunnel-list`. */
  private buildCard(): void {
    if (!this.container) return;
    this.container.innerHTML = `
      <div class="tunnel-manager">
        <div class="device-list-header">
          <h2>Tunnels</h2>
        </div>
        <div class="tunnel-list-items"></div>
      </div>
    `;
    this.body = this.container.querySelector<HTMLElement>(".tunnel-list-items");
  }

  private render(): void {
    if (!this.body) return;
    this.body.replaceChildren();

    const devices = tunnelableDevices(this.devices);
    if (devices.length === 0) {
      const empty = document.createElement("p");
      empty.className = "tunnels-empty";
      empty.textContent =
        "No device has port forwards. Add one in a device's editor to tunnel here.";
      this.body.appendChild(empty);
      return;
    }
    for (const device of devices) {
      this.body.appendChild(this.renderDeviceCard(device));
    }
  }

  private renderDeviceCard(device: SshDevice): HTMLElement {
    const state = this.byDevice.get(device.id);
    const running = state !== undefined;
    const status: TunnelStatus | "stopped" = state?.status ?? "stopped";

    const card = document.createElement("div");
    card.className = "tunnel-card";
    card.dataset.deviceId = device.id;

    const header = document.createElement("div");
    header.className = "tunnel-card-header";

    const title = document.createElement("span");
    title.className = "tunnel-card-name";
    title.textContent = device.name;

    const chip = document.createElement("span");
    chip.className = `tunnel-chip is-${status}`;
    chip.textContent = statusLabel(status);

    const action = document.createElement("button");
    action.type = "button";
    action.className = running ? "btn btn-danger btn-small" : "btn btn-primary btn-small";
    action.textContent = running ? "Stop" : "Start";
    action.addEventListener("click", () => {
      void (running ? this.handleStop(device.id) : this.handleStart(device.id));
    });

    header.append(title, chip, action);
    card.appendChild(header);
    card.appendChild(this.renderForwards(device, state));
    return card;
  }

  /**
   * Per-forward rows. Once the tunnel is listening the backend reports real bind
   * state (`state.forwards`); before that we show the device's configured
   * forwards so the user sees what will be bound.
   */
  private renderForwards(
    device: SshDevice,
    state: DeviceTunnelState | undefined,
  ): HTMLElement {
    const list = document.createElement("ul");
    list.className = "tunnel-forwards";

    const live = state?.forwards ?? [];
    const rows = device.forwards.map((forward) => {
      const bindState = live.find((f) => f.forwardId === forward.id);
      return {
        text: forwardEndpoint(forward),
        bound: bindState?.bound,
      };
    });

    for (const row of rows) {
      const li = document.createElement("li");
      li.className = "tunnel-forward";
      if (row.bound === false) li.classList.add("is-unbound");

      const endpoint = document.createElement("code");
      endpoint.className = "tunnel-forward-endpoint";
      endpoint.textContent = row.text;

      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "btn btn-secondary btn-small tunnel-copy";
      copy.textContent = "Copy";
      copy.title = "Copy the local address:port";
      copy.addEventListener("click", () => {
        // Copy just the local `addr:port` (before the arrow) — what a DB client needs.
        void this.copyEndpoint(row.text.split(" → ")[0] ?? row.text);
      });

      li.append(endpoint, copy);
      if (row.bound === false) {
        const warn = document.createElement("span");
        warn.className = "tunnel-forward-warn";
        warn.textContent = "port in use";
        li.appendChild(warn);
      }
      list.appendChild(li);
    }
    return list;
  }
}

/** Constructs and initializes the Tunnels panel. */
export function initTunnelsPanel(
  options: TunnelsPanelOptions = {},
): TunnelsPanel {
  const panel = new TunnelsPanel(options);
  void panel.init();
  return panel;
}
