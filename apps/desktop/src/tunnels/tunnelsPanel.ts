/**
 * The Tunnels sidebar card (SPEC tunnels §6): a section under Devices listing
 * every SSH device that has port forwards with a Start/Stop control, a live
 * status icon, and per-forward rows (name over `local → remote`, with
 * copy-endpoint). It is intentionally separate from the terminal grid — a
 * tunnel has no terminal and is long-lived — so `grid.ts` / `pane.ts` are
 * untouched.
 *
 * Live state comes from `tunnel_status` events (keyed by `tunnelId`); the panel
 * maps those back to devices so each device row reflects its own tunnel.
 *
 * Launch restores what the user last did: a tunnel they started stays started
 * on the next launch, one they stopped stays stopped. A device with no such
 * remembered choice follows its `tunnelAutoStart` flag.
 */

import {
  listDevices,
  listTunnels,
  onTunnelStatus,
  startTunnel,
  stopTunnel,
  type AppError,
  type Device,
  type Forward,
  type ForwardStatus,
  type SshDevice,
  type TunnelStatus,
  type TunnelStatusEvent,
} from "../ipc";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { t } from "../i18n";
import { copyIcon, playIcon, stopIcon, wifiIcon, wifiOffIcon } from "../ui/icons";

/** Per-device tunnel state the panel tracks between renders. */
interface DeviceTunnelState {
  tunnelId: string;
  status: TunnelStatus;
  forwards: ForwardStatus[];
}

/** deviceId → whether the user last left its tunnel running (persisted in
 * `workspace_state.json`). */
export type TunnelRunState = Record<string, boolean>;

export interface TunnelsPanelOptions {
  onError?: (error: AppError) => void;
  onSuccess?: (message: string) => void;
  /** The remembered run state to restore on launch. */
  initialState?: TunnelRunState;
  /** Fired when the user starts/stops a tunnel, so the caller schedules a save. */
  onPersist?: () => void;
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
      return t("tunnels.status.connecting");
    case "listening":
      return t("tunnels.status.listening");
    case "error":
      return t("tunnels.status.error");
    case "disconnected":
    case "stopped":
      return t("tunnels.status.stopped");
  }
}

/**
 * `127.0.0.1:5432 → db.internal:5432` for a forward's endpoints, or
 * `127.0.0.1:1080 → SOCKS proxy` for a dynamic one.
 */
export function forwardEndpoint(
  forward: Pick<Forward, "kind" | "localAddr" | "localPort" | "remoteHost" | "remotePort">,
): string {
  const target =
    forward.kind === "dynamic"
      ? t("forwards.socksProxy")
      : `${forward.remoteHost}:${forward.remotePort}`;
  return `${forward.localAddr}:${forward.localPort} → ${target}`;
}

export class TunnelsPanel {
  private devices: Device[] = [];
  /** deviceId → its live tunnel state (present only while a tunnel runs). */
  private readonly byDevice = new Map<string, DeviceTunnelState>();
  /** tunnelId → deviceId, so a `tunnel_status` event routes to the right row. */
  private readonly deviceByTunnel = new Map<string, string>();
  /** The user's last explicit Start (true) / Stop (false) per device. */
  private readonly remembered: Map<string, boolean>;
  /** False until the device list has loaded (pruning before that would drop
   * every remembered entry). */
  private devicesLoaded = false;
  /** Tunnels whose `startTunnel` hasn't returned: the backend may not know the
   * id yet, so a stop sent now can be a no-op. */
  private readonly startsInFlight = new Set<string>();
  /** Stops requested for a tunnel still starting — re-sent once it has. */
  private readonly stopsPending = new Set<string>();
  private unlisten: UnlistenFn | null = null;
  private readonly container: HTMLElement | null;
  private body: HTMLElement | null = null;

  constructor(private readonly options: TunnelsPanelOptions = {}) {
    // The sidebar card container (mirrors how the device/profile managers bind
    // to their `.device-list` / `.profile-list` sections).
    this.container = document.querySelector<HTMLElement>(".tunnel-list");
    this.remembered = new Map(Object.entries(options.initialState ?? {}));
  }

  async init(): Promise<void> {
    this.buildCard();
    const devices = await this.safeListDevices();
    // A failed load is not "no devices": leave the remembered state unpruned.
    this.devices = devices ?? [];
    this.devicesLoaded = devices !== null;
    await this.adoptRunningTunnels();
    this.subscribe();
    this.render();
    await this.autoStartFlagged();
  }

  /**
   * Start the tunnels that should run at launch (see `shouldRunAtLaunch`) —
   * unless one is already running (adopted above). Sequential so a burst of
   * failures surfaces as individual toasts rather than all at once.
   */
  private async autoStartFlagged(): Promise<void> {
    for (const device of tunnelableDevices(this.devices)) {
      if (this.shouldRunAtLaunch(device) && !this.byDevice.has(device.id)) {
        await this.handleStart(device.id);
      }
    }
  }

  /** The user's remembered choice, else the device's auto-start flag. */
  private shouldRunAtLaunch(device: SshDevice): boolean {
    return this.remembered.get(device.id) ?? device.tunnelAutoStart;
  }

  /** The remembered run state to persist, limited to devices that still have
   * forwards; `undefined` when there is nothing to remember. */
  layoutState(): TunnelRunState | undefined {
    if (!this.devicesLoaded) return this.options.initialState;
    const ids = new Set(tunnelableDevices(this.devices).map((d) => d.id));
    const kept = [...this.remembered].filter(([id]) => ids.has(id));
    return kept.length > 0 ? Object.fromEntries(kept) : undefined;
  }

  /** Record an explicit Start/Stop and ask the caller to save it. */
  private remember(deviceId: string, running: boolean): void {
    this.remembered.set(deviceId, running);
    this.options.onPersist?.();
  }

  /** Refresh the device list (called when devices are added/edited/deleted). */
  setDevices(devices: Device[]): void {
    this.devices = devices;
    this.devicesLoaded = true;
    this.stopOrphans();
    this.render();
  }

  /** Stop every running tunnel whose device was deleted or no longer has
   * forwards — its row is gone, so nothing else could ever stop it. */
  private stopOrphans(): void {
    for (const [deviceId, state] of this.byDevice) {
      if (!this.isTunnelable(deviceId)) {
        void this.requestStop(state.tunnelId);
      }
    }
  }

  private isTunnelable(deviceId: string): boolean {
    return tunnelableDevices(this.devices).some((d) => d.id === deviceId);
  }

  private async requestStop(tunnelId: string): Promise<void> {
    if (this.startsInFlight.has(tunnelId)) this.stopsPending.add(tunnelId);
    try {
      await stopTunnel(tunnelId);
    } catch (err) {
      this.options.onError?.(err as AppError);
    }
  }

  /** Re-fetch devices from the backend and re-render (device CRUD happened).
   * A failed fetch changes nothing — it must not read as "every device gone". */
  async refresh(): Promise<void> {
    const devices = await this.safeListDevices();
    if (devices) this.setDevices(devices);
  }

  /** Rebuild the card shell + rows in the current locale (language change). */
  retranslate(): void {
    this.buildCard();
    this.render();
  }

  /** Stop listening — used by tests; the app keeps the panel for its lifetime. */
  dispose(): void {
    this.unlisten?.();
    this.unlisten = null;
  }

  /** The device list, or `null` when it couldn't be loaded (error toasted). */
  private async safeListDevices(): Promise<Device[] | null> {
    try {
      return await listDevices();
    } catch (err) {
      this.options.onError?.(err as AppError);
      return null;
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
          message: event.message ?? t("tunnels.error.generic"),
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

  /**
   * Start a device's tunnel. `manual` marks a user click, remembered as "keep
   * running" once the backend accepted it. A start the backend rejects outright
   * is a configuration problem (not a flaky network), so it is remembered as
   * stopped rather than retried — and failing — on every launch.
   */
  private async handleStart(deviceId: string, manual = false): Promise<void> {
    // The id is chosen here so status events (which can beat the command's
    // return) route to this row, and Stop works while the start is in flight.
    const tunnelId = crypto.randomUUID();
    this.deviceByTunnel.set(tunnelId, deviceId);
    // Optimistically mark connecting so the row reflects the click immediately.
    this.byDevice.set(deviceId, { tunnelId, status: "connecting", forwards: [] });
    this.render();
    this.startsInFlight.add(tunnelId);
    try {
      await startTunnel(deviceId, tunnelId);
      this.startsInFlight.delete(tunnelId);
      this.afterStarted(deviceId, tunnelId, manual);
    } catch (err) {
      this.startsInFlight.delete(tunnelId);
      this.stopsPending.delete(tunnelId);
      this.deviceByTunnel.delete(tunnelId);
      this.byDevice.delete(deviceId);
      this.remember(deviceId, false);
      this.render();
      this.options.onError?.(err as AppError);
    }
  }

  /** The backend has the tunnel now: honour a Stop clicked meanwhile, or a
   * device deleted meanwhile; otherwise remember a manual start. */
  private afterStarted(deviceId: string, tunnelId: string, manual: boolean): void {
    const stopWanted = this.stopsPending.delete(tunnelId);
    if (stopWanted || !this.isTunnelable(deviceId)) {
      void this.requestStop(tunnelId);
      return;
    }
    if (manual) this.remember(deviceId, true);
  }

  private async handleStop(deviceId: string): Promise<void> {
    const state = this.byDevice.get(deviceId);
    if (!state) return;
    await this.requestStop(state.tunnelId);
  }

  private async copyEndpoint(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.options.onSuccess?.(t("tunnels.copied"));
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
          <h2>${t("tunnels.title")}</h2>
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
      empty.textContent = t("tunnels.empty");
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

    header.append(title, statusIconEl(status), this.renderAction(device, running));
    card.appendChild(header);
    card.appendChild(this.renderForwards(device, state));
    return card;
  }

  /** The Start (play) / Stop (stop) icon button for a device's tunnel. */
  private renderAction(device: SshDevice, running: boolean): HTMLButtonElement {
    const action = iconButton(
      running ? "btn-danger" : "btn-primary",
      running ? stopIcon : playIcon,
      running ? t("tunnels.stop") : t("tunnels.start"),
    );
    action.addEventListener("click", () => {
      if (running) {
        this.remember(device.id, false);
        void this.handleStop(device.id);
      } else {
        void this.handleStart(device.id, true);
      }
    });
    return action;
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
        name: forward.name,
        text: forwardEndpoint(forward),
        bound: bindState?.bound,
      };
    });

    for (const row of rows) {
      const li = document.createElement("li");
      li.className = "tunnel-forward";
      if (row.bound === false) li.classList.add("is-unbound");

      const copy = iconButton("btn-secondary tunnel-copy", copyIcon, t("tunnels.copy.title"));
      copy.addEventListener("click", () => {
        // Copy just the local `addr:port` (before the arrow) — what a DB client needs.
        void this.copyEndpoint(row.text.split(" → ")[0] ?? row.text);
      });

      li.append(forwardTextEl(row), copy);
      list.appendChild(li);
    }
    return list;
  }
}

/**
 * The tunnel's status as an icon: wifi while listening or connecting (colored
 * per state by CSS), crossed-out wifi otherwise. The label stays available as
 * a tooltip and to assistive tech.
 */
function statusIconEl(status: TunnelStatus | "stopped"): HTMLElement {
  const active = status === "listening" || status === "connecting";
  const label = statusLabel(status);
  const el = document.createElement("span");
  el.className = `tunnel-status is-${status}`;
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", label);
  el.title = label;
  el.innerHTML = active ? wifiIcon : wifiOffIcon;
  return el;
}

/**
 * A forward's name (plus a "port in use" flag when it failed to bind) over its
 * `local → remote` endpoint. Both lines truncate in a narrow sidebar, so each
 * keeps its full text as a tooltip.
 */
function forwardTextEl(row: { name: string; text: string; bound?: boolean }): HTMLElement {
  const text = document.createElement("div");
  text.className = "tunnel-forward-text";

  const label = document.createElement("div");
  label.className = "tunnel-forward-label";
  label.appendChild(truncatedEl("span", "tunnel-forward-name", row.name));
  if (row.bound === false) {
    const warn = document.createElement("span");
    warn.className = "tunnel-forward-warn";
    warn.textContent = t("tunnels.portInUse");
    label.appendChild(warn);
  }

  text.append(label, truncatedEl("code", "tunnel-forward-endpoint", row.text));
  return text;
}

/** An element whose text may be cut off by CSS, with the full text as tooltip. */
function truncatedEl(tag: string, className: string, value: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = value;
  el.title = value;
  return el;
}

/** An icon-only button; `label` becomes its tooltip and accessible name. */
function iconButton(variant: string, icon: string, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `btn btn-icon ${variant}`;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = icon;
  return button;
}

/** Constructs and initializes the Tunnels panel. */
export function initTunnelsPanel(
  options: TunnelsPanelOptions = {},
): TunnelsPanel {
  const panel = new TunnelsPanel(options);
  void panel.init();
  return panel;
}
