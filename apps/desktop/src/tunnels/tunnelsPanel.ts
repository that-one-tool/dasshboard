/**
 * The Tunnels sidebar card (SPEC tunnels §6): a section under Devices listing
 * every SSH device that has port forwards with a Start all / Stop all control,
 * a live status icon, and per-forward rows (status dot, name over
 * `local → remote`, copy-endpoint, and the forward's own Start/Stop). It is
 * intentionally separate from the terminal grid — a tunnel has no terminal and
 * is long-lived — so `grid.ts` / `pane.ts` are untouched.
 *
 * A device's forwards share one SSH connection (one backend tunnel): starting a
 * forward on a stopped device opens it, starting one on a running device binds
 * it on that connection, and stopping its last forward closes it. Editing a
 * running device's connection settings restarts its tunnel; editing a running
 * forward re-binds just that forward.
 *
 * Live state comes from `tunnel_status` events (keyed by `tunnelId`); the panel
 * maps those back to devices so each device row reflects its own tunnel.
 *
 * Launch restores what the user last did: the forwards they left running are
 * started again, the rest stay stopped. A device with no such remembered
 * choice follows its `tunnelAutoStart` flag (all forwards, or none).
 */

import {
  listDevices,
  listTunnels,
  onTunnelStatus,
  startTunnel,
  startTunnelForward,
  stopTunnel,
  stopTunnelForward,
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

export interface TunnelsPanelOptions {
  onError?: (error: AppError) => void;
  onSuccess?: (message: string) => void;
  /** The remembered run state to restore on launch. */
  initialState?: TunnelRunState;
  /** Fired when the user starts/stops a tunnel, so the caller schedules a save. */
  onPersist?: () => void;
  /** Fired on every re-render (any tunnel change): the side menu recounts the
   * running forwards. */
  onForwardsChange?: () => void;
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

/** Human label for a forward's status dot. */
function forwardStateLabel(state: ForwardState): string {
  return state === "unbound" ? t("tunnels.portInUse") : statusLabel(state);
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
  const live = state.forwards.find((f) => f.forwardId === forwardId);
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
  if (typeof wanted === "boolean") return wanted ? all : [];
  return all.filter((id) => wanted.includes(id));
}

/** The choice to remember for a set of running forwards: their ids (so a
 * forward added to the device later is not started for the user), or `false`. */
export function runChoiceOf(device: SshDevice, running: Set<string>): TunnelRunChoice {
  const ids = runningInOrder(device, running);
  return ids.length > 0 ? ids : false;
}

/** The device's forward ids that are in `running`, in the device's order. */
function runningInOrder(device: SshDevice, running: Set<string>): string[] {
  return device.forwards.map((f) => f.id).filter((id) => running.has(id));
}

/** What a tunnel's SSH connection depends on: changing any of it restarts the
 * tunnel. (A new password needs no restart — the open connection already
 * authenticated — and the frontend never sees it anyway.) */
function connectionKey(device: SshDevice): string {
  const { host, port, username, auth, proxyJump } = device;
  return JSON.stringify([host, port, username, auth, proxyJump]);
}

/** What a bound forward's listener depends on (its name is cosmetic). */
function forwardKey(forward: Forward): string {
  const { kind, localAddr, localPort, remoteHost, remotePort } = forward;
  return JSON.stringify([kind, localAddr, localPort, remoteHost, remotePort]);
}

/** Whether forward `id` exists in both versions of a device but was edited. */
function forwardEdited(before: SshDevice, after: SshDevice, id: string): boolean {
  const old = before.forwards.find((f) => f.id === id);
  const now = after.forwards.find((f) => f.id === id);
  return old !== undefined && now !== undefined && forwardKey(old) !== forwardKey(now);
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
  /** The user's last explicit Start/Stop per device. */
  private readonly remembered: Map<string, TunnelRunChoice>;
  /** False until the device list has loaded (pruning before that would drop
   * every remembered entry). */
  private devicesLoaded = false;
  /** Tunnels whose `startTunnel` hasn't returned: the backend may not know the
   * id yet, so forward changes wait and are reconciled once it has. */
  private readonly startsInFlight = new Set<string>();
  /** Tunnels being stopped to restart with new connection settings: forward
   * changes wait, and the replacement starts once the old one let go of its
   * ports. */
  private readonly restarts = new Set<string>();
  /** deviceId → the tail of its pending backend calls. Forward adds/removes
   * are deltas, so they must reach the tunnel in click order. */
  private readonly calls = new Map<string, Promise<void>>();
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
   * Start the forwards that should run at launch (see `forwardIdsToRun`) —
   * unless the device's tunnel is already running (adopted above). Sequential
   * so a burst of failures surfaces as individual toasts rather than all at
   * once.
   */
  private async autoStartFlagged(): Promise<void> {
    for (const device of tunnelableDevices(this.devices)) {
      const ids = forwardIdsToRun(device, this.remembered.get(device.id));
      if (ids.length > 0 && !this.byDevice.has(device.id)) {
        await this.startTunnelWith(device.id, ids);
      }
    }
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
  private remember(deviceId: string, choice: TunnelRunChoice): void {
    this.remembered.set(deviceId, choice);
    this.options.onPersist?.();
  }

  /** Remember `running` as the device's forwards to keep running. */
  private rememberRunning(deviceId: string, running: Set<string>): void {
    const device = this.tunnelable(deviceId);
    if (device) this.remember(deviceId, runChoiceOf(device, running));
  }

  /** Refresh the device list (called when devices are added/edited/deleted). */
  setDevices(devices: Device[]): void {
    const previous = this.devices;
    this.devices = devices;
    this.devicesLoaded = true;
    this.stopOrphans();
    this.releaseDeletedForwards();
    this.applyEdits(previous);
    this.render();
  }

  /** Stop every running tunnel whose device was deleted or no longer has
   * forwards — its row is gone, so nothing else could ever stop it. */
  private stopOrphans(): void {
    for (const [deviceId, state] of this.byDevice) {
      if (!this.tunnelable(deviceId)) {
        void this.requestStop(deviceId, state.tunnelId);
      }
    }
  }

  /** Release running forwards deleted from their (still tunnelable) device —
   * their rows are gone, so nothing else could ever stop them. */
  private releaseDeletedForwards(): void {
    for (const [deviceId, state] of this.byDevice) {
      const device = this.tunnelable(deviceId);
      if (device) this.releaseMissing(device, state);
    }
  }

  private releaseMissing(device: SshDevice, state: DeviceTunnelState): void {
    const existing = new Set(device.forwards.map((f) => f.id));
    const missing = [...state.requested].filter((id) => !existing.has(id));
    for (const id of missing) {
      state.requested.delete(id);
      if (!this.isDeferred(state.tunnelId)) void this.sendStopForward(device.id, state, id);
    }
  }

  /** Restart tunnels whose device's connection settings were edited, and
   * re-bind running forwards that were edited. */
  private applyEdits(previous: Device[]): void {
    for (const [deviceId, state] of this.byDevice) {
      const before = tunnelableDevices(previous).find((d) => d.id === deviceId);
      const after = this.tunnelable(deviceId);
      if (before && after && state.requested.size > 0) this.applyEdit(before, after, state);
    }
  }

  private applyEdit(before: SshDevice, after: SshDevice, state: DeviceTunnelState): void {
    if (before.proxyJump && !after.proxyJump) {
      this.stopForLostJumpHost(after);
      return;
    }
    if (connectionKey(before) !== connectionKey(after)) {
      this.restart(after.id, state);
      return;
    }
    for (const id of state.requested) {
      if (forwardEdited(before, after, id)) this.bindForward(after.id, state, id);
    }
  }

  /** The device's jump host was removed (deleted): restarting would now reach
   * the target directly, so stop the tunnel instead and say why. */
  private stopForLostJumpHost(device: SshDevice): void {
    this.stopAll(device.id);
    this.options.onError?.({
      code: "Validation",
      message: t("tunnels.error.jumpRemoved", { name: device.name }),
    });
  }

  /** Stop the tunnel now; `onEnded` starts its replacement once it is gone. */
  private restart(deviceId: string, state: DeviceTunnelState): void {
    this.restarts.add(state.tunnelId);
    state.status = "connecting";
    state.forwards = [];
    void this.requestStop(deviceId, state.tunnelId);
  }

  private tunnelable(deviceId: string): SshDevice | undefined {
    return tunnelableDevices(this.devices).find((d) => d.id === deviceId);
  }

  /** The device's tunnel unless it is stopping (no forward wanted any more). */
  private activeState(deviceId: string): DeviceTunnelState | undefined {
    const state = this.byDevice.get(deviceId);
    return state && state.requested.size > 0 ? state : undefined;
  }

  /** Whether forward changes to this tunnel must wait (it is starting, or
   * being replaced) rather than be sent now. */
  private isDeferred(tunnelId: string): boolean {
    return this.startsInFlight.has(tunnelId) || this.restarts.has(tunnelId);
  }

  /** Run a backend call after the device's earlier ones. */
  private enqueue(deviceId: string, call: () => Promise<void>): Promise<void> {
    const next = (this.calls.get(deviceId) ?? Promise.resolve()).then(call);
    this.calls.set(deviceId, next);
    return next;
  }

  /** Stop a tunnel. Should the request fail, the forwards in `restore` are
   * shown running again — the tunnel still is. */
  private requestStop(
    deviceId: string,
    tunnelId: string,
    restore: Iterable<string> = [],
  ): Promise<void> {
    return this.enqueue(deviceId, async () => {
      try {
        await stopTunnel(tunnelId);
      } catch (err) {
        this.restoreRequested(deviceId, tunnelId, restore);
        this.options.onError?.(err as AppError);
      }
    });
  }

  /** Mark forwards running again after a stop request failed. */
  private restoreRequested(deviceId: string, tunnelId: string, ids: Iterable<string>): void {
    const state = this.byDevice.get(deviceId);
    if (state?.tunnelId !== tunnelId) return;
    for (const id of ids) state.requested.add(id);
    this.rememberRunning(deviceId, state.requested);
    this.render();
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

  /** Reflect tunnels already running (e.g. after a UI reload), including ones
   * still connecting, which report the forwards they will bind. */
  private async adoptRunningTunnels(): Promise<void> {
    let running;
    try {
      running = await listTunnels();
    } catch {
      return; // non-fatal: the panel just starts with nothing marked running
    }
    for (const { tunnelId, deviceId, forwardIds, forwards } of running) {
      this.deviceByTunnel.set(tunnelId, deviceId);
      this.byDevice.set(deviceId, {
        tunnelId,
        status: forwards.length > 0 ? "listening" : "connecting",
        requested: new Set(forwardIds),
        forwards,
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
      this.onEnded(deviceId, event);
    } else {
      this.applyLive(deviceId, event);
    }
    this.render();
  }

  /** A tunnel ended: forget it, report an error, and start its replacement if
   * it was stopped to restart. */
  private onEnded(deviceId: string, event: TunnelStatusEvent): void {
    const restartWith = this.takeRestart(deviceId, event.tunnelId);
    this.forgetTunnel(deviceId, event.tunnelId);
    if (event.status === "error") {
      this.options.onError?.({
        code: "TunnelBind",
        message: event.message ?? t("tunnels.error.generic"),
      });
    }
    if (restartWith.length > 0) void this.startTunnelWith(deviceId, restartWith);
  }

  /** The forwards a restarting tunnel's replacement should carry — what the
   * user still wants, among the forwards the device still has. */
  private takeRestart(deviceId: string, tunnelId: string): string[] {
    const device = this.tunnelable(deviceId);
    const state = this.byDevice.get(deviceId);
    if (!this.restarts.delete(tunnelId) || !device || state?.tunnelId !== tunnelId) return [];
    return runningInOrder(device, state.requested);
  }

  /** Record a `connecting` / `listening` status on the device's tunnel (a
   * tunnel being replaced keeps showing connecting). */
  private applyLive(deviceId: string, event: TunnelStatusEvent): void {
    const state = this.byDevice.get(deviceId);
    if (state?.tunnelId !== event.tunnelId || this.restarts.has(event.tunnelId)) return;
    state.status = event.status;
    if (event.status === "listening") state.forwards = event.forwards;
  }

  /** Drop an ended tunnel — but not a newer one started for the same device. */
  private forgetTunnel(deviceId: string, tunnelId: string): void {
    this.deviceByTunnel.delete(tunnelId);
    if (this.byDevice.get(deviceId)?.tunnelId === tunnelId) {
      this.byDevice.delete(deviceId);
    }
  }

  /* ----- user actions ----------------------------------------------------- */

  private startAll(device: SshDevice): void {
    void this.startTunnelWith(
      device.id,
      device.forwards.map((f) => f.id),
      true,
    );
  }

  private stopAll(deviceId: string): void {
    const state = this.activeState(deviceId);
    if (!state) return;
    const previous = [...state.requested];
    state.requested.clear();
    this.rememberRunning(deviceId, state.requested);
    this.render();
    void this.requestStop(deviceId, state.tunnelId, previous);
  }

  /** Start one forward: on the device's running tunnel, else on a new one. */
  private startForward(deviceId: string, forwardId: string): void {
    const state = this.activeState(deviceId);
    if (!state) {
      void this.startTunnelWith(deviceId, [forwardId], true);
      return;
    }
    state.requested.add(forwardId);
    this.rememberRunning(deviceId, state.requested);
    this.bindForward(deviceId, state, forwardId);
    this.render();
  }

  /** (Re-)bind a forward on a running tunnel — unless its changes wait. */
  private bindForward(deviceId: string, state: DeviceTunnelState, forwardId: string): void {
    // A stale "bound" from an earlier binding must not paint it green early.
    state.forwards = state.forwards.filter((f) => f.forwardId !== forwardId);
    if (!this.isDeferred(state.tunnelId)) {
      void this.sendStartForward(deviceId, state.tunnelId, forwardId);
    }
  }

  /** Stop one forward; the last one stops the whole tunnel. */
  private stopForward(deviceId: string, forwardId: string): void {
    const state = this.activeState(deviceId);
    if (!state) return;
    state.requested.delete(forwardId);
    this.rememberRunning(deviceId, state.requested);
    this.render();
    if (!this.isDeferred(state.tunnelId)) {
      void this.sendStopForward(deviceId, state, forwardId);
    }
  }

  private sendStartForward(deviceId: string, tunnelId: string, forwardId: string): Promise<void> {
    return this.enqueue(deviceId, async () => {
      try {
        await startTunnelForward(tunnelId, forwardId);
      } catch (err) {
        this.dropRequested(deviceId, tunnelId, forwardId);
        this.options.onError?.(err as AppError);
      }
    });
  }

  /** Un-ask a forward the backend refused to bind (it shows stopped again). */
  private dropRequested(deviceId: string, tunnelId: string, forwardId: string): void {
    const state = this.byDevice.get(deviceId);
    if (state?.tunnelId !== tunnelId) return;
    state.requested.delete(forwardId);
    this.rememberRunning(deviceId, state.requested);
    this.render();
  }

  private sendStopForward(
    deviceId: string,
    state: DeviceTunnelState,
    forwardId: string,
  ): Promise<void> {
    if (state.requested.size === 0) {
      return this.requestStop(deviceId, state.tunnelId, [forwardId]);
    }
    return this.enqueue(deviceId, async () => {
      try {
        await stopTunnelForward(state.tunnelId, forwardId);
      } catch (err) {
        this.restoreRequested(deviceId, state.tunnelId, [forwardId]);
        this.options.onError?.(err as AppError);
      }
    });
  }

  /**
   * Open a device's tunnel carrying `forwardIds`. `manual` marks a user click,
   * remembered once the backend accepted it. A start the backend rejects
   * outright is a configuration problem (not a flaky network), so it is
   * remembered as stopped rather than retried — and failing — on every launch.
   */
  private async startTunnelWith(
    deviceId: string,
    forwardIds: string[],
    manual = false,
  ): Promise<void> {
    // The id is chosen here so status events (which can beat the command's
    // return) route to this row, and Stop works while the start is in flight.
    const tunnelId = crypto.randomUUID();
    this.deviceByTunnel.set(tunnelId, deviceId);
    // Optimistically mark connecting so the row reflects the click immediately.
    this.byDevice.set(deviceId, {
      tunnelId,
      status: "connecting",
      requested: new Set(forwardIds),
      forwards: [],
    });
    this.render();
    this.startsInFlight.add(tunnelId);
    try {
      await startTunnel(deviceId, tunnelId, forwardIds);
      this.startsInFlight.delete(tunnelId);
      this.afterStarted(deviceId, tunnelId, forwardIds, manual);
    } catch (err) {
      this.startsInFlight.delete(tunnelId);
      this.forgetTunnel(deviceId, tunnelId);
      this.remember(deviceId, false);
      this.render();
      this.options.onError?.(err as AppError);
    }
  }

  /** The backend has the tunnel now. If the row has moved on (stopped and
   * started again, or the tunnel already ended), make sure it is gone — it
   * would hold ports nothing shows. Otherwise remember a manual start and apply
   * the changes made meanwhile. */
  private afterStarted(
    deviceId: string,
    tunnelId: string,
    startedWith: string[],
    manual: boolean,
  ): void {
    const state = this.byDevice.get(deviceId);
    if (state?.tunnelId !== tunnelId) {
      void this.requestStop(deviceId, tunnelId);
      return;
    }
    if (manual) this.rememberRunning(deviceId, state.requested);
    this.reconcile(deviceId, state, startedWith);
  }

  private reconcile(deviceId: string, state: DeviceTunnelState, startedWith: string[]): void {
    if (this.shouldEnd(deviceId, state)) {
      void this.requestStop(deviceId, state.tunnelId);
      return;
    }
    this.sendMissingStarts(deviceId, state, startedWith);
    this.sendUnwantedStops(deviceId, state, startedWith);
  }

  /** Stopped while starting, device deleted, or due for a restart. */
  private shouldEnd(deviceId: string, state: DeviceTunnelState): boolean {
    return (
      state.requested.size === 0 ||
      !this.tunnelable(deviceId) ||
      this.restarts.has(state.tunnelId)
    );
  }

  private sendMissingStarts(
    deviceId: string,
    state: DeviceTunnelState,
    startedWith: string[],
  ): void {
    const missing = [...state.requested].filter((id) => !startedWith.includes(id));
    for (const id of missing) void this.sendStartForward(deviceId, state.tunnelId, id);
  }

  private sendUnwantedStops(
    deviceId: string,
    state: DeviceTunnelState,
    startedWith: string[],
  ): void {
    const unwanted = startedWith.filter((id) => !state.requested.has(id));
    for (const id of unwanted) void this.sendStopForward(deviceId, state, id);
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

  /** How many forwards are listening right now (the side menu's chip), on
   * the devices the card shows: a deleted device's tunnel can linger until the
   * backend confirms its stop, or for good if the stop failed. */
  listeningForwardCount(): number {
    const shown = tunnelableDevices(this.devices).map((device) => this.byDevice.get(device.id));
    return listeningForwardCount(shown.filter((state) => state !== undefined));
  }

  private render(): void {
    this.options.onForwardsChange?.();
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
    const state = this.activeState(device.id);
    const status: TunnelStatus | "stopped" = state?.status ?? "stopped";

    const card = document.createElement("div");
    card.className = "tunnel-card";
    card.dataset.deviceId = device.id;

    const header = document.createElement("div");
    header.className = "tunnel-card-header";

    const title = document.createElement("span");
    title.className = "tunnel-card-name";
    title.textContent = device.name;

    header.append(title, statusIconEl(status), this.renderAllAction(device, state !== undefined));
    card.appendChild(header);
    card.appendChild(this.renderForwards(device, state));
    return card;
  }

  /** The Start all (play) / Stop all (stop) icon button for a device. */
  private renderAllAction(device: SshDevice, running: boolean): HTMLButtonElement {
    const action = iconButton(
      running ? "btn-danger" : "btn-primary",
      running ? stopIcon : playIcon,
      running ? t("tunnels.stopAll") : t("tunnels.startAll"),
    );
    action.addEventListener("click", () => {
      if (running) this.stopAll(device.id);
      else this.startAll(device);
    });
    return action;
  }

  /**
   * Per-forward rows: status dot, name over endpoint, copy, and the forward's
   * own Start/Stop. Every configured forward is listed, running or not.
   */
  private renderForwards(
    device: SshDevice,
    state: DeviceTunnelState | undefined,
  ): HTMLElement {
    const list = document.createElement("ul");
    list.className = "tunnel-forwards";
    for (const forward of device.forwards) {
      list.appendChild(this.renderForward(device.id, forward, forwardState(state, forward.id)));
    }
    return list;
  }

  private renderForward(deviceId: string, forward: Forward, state: ForwardState): HTMLElement {
    const text = forwardEndpoint(forward);
    const li = document.createElement("li");
    li.className = "tunnel-forward";
    li.dataset.forwardId = forward.id;
    if (state === "unbound") li.classList.add("is-unbound");

    const copy = iconButton("btn-secondary tunnel-copy", copyIcon, t("tunnels.copy.title"));
    copy.addEventListener("click", () => {
      // Copy just the local `addr:port` (before the arrow) — what a DB client needs.
      void this.copyEndpoint(text.split(" → ")[0] ?? text);
    });

    li.append(
      forwardDotEl(state),
      forwardTextEl({ name: forward.name, text, unbound: state === "unbound" }),
      copy,
      this.renderForwardAction(deviceId, forward.id, state !== "stopped"),
    );
    return li;
  }

  /** The Start (play) / Stop (stop) icon button for one forward. */
  private renderForwardAction(
    deviceId: string,
    forwardId: string,
    running: boolean,
  ): HTMLButtonElement {
    const action = iconButton(
      `${running ? "btn-danger" : "btn-primary"} tunnel-forward-toggle`,
      running ? stopIcon : playIcon,
      running ? t("tunnels.stop") : t("tunnels.start"),
    );
    action.addEventListener("click", () => {
      if (running) this.stopForward(deviceId, forwardId);
      else this.startForward(deviceId, forwardId);
    });
    return action;
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

/** A forward's status as a colored dot (gray / yellow / green / red), labelled
 * for the tooltip and assistive tech. */
function forwardDotEl(state: ForwardState): HTMLElement {
  const label = forwardStateLabel(state);
  const el = document.createElement("span");
  el.className = `tunnel-forward-dot is-${state}`;
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", label);
  el.title = label;
  return el;
}

/**
 * A forward's name (plus a "port in use" flag when it failed to bind) over its
 * `local → remote` endpoint. Both lines truncate in a narrow sidebar, so each
 * keeps its full text as a tooltip.
 */
function forwardTextEl(row: { name: string; text: string; unbound: boolean }): HTMLElement {
  const text = document.createElement("div");
  text.className = "tunnel-forward-text";

  const label = document.createElement("div");
  label.className = "tunnel-forward-label";
  label.appendChild(truncatedEl("span", "tunnel-forward-name", row.name));
  if (row.unbound) {
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
