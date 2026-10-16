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
 *
 * A tunnel that drops on its own is reopened, with the forwards the user still
 * wants, when its device opted into auto-reconnect — the terminal panes'
 * policy (`tunnelReconnect.ts`). While it waits it shows as connecting, and a
 * Stop cancels it.
 *
 * This class orchestrates; the rules live in `tunnelForwards`, the
 * bookkeeping in `tunnelRegistry` / `tunnelRunMemory` / `deviceCallQueue`, and
 * the DOM in `tunnelCardView`.
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
  type ErrorCode,
  type ForwardStatus,
  type SshDevice,
  type TunnelInfo,
  type TunnelStatus,
  type TunnelStatusEvent,
} from "../ipc";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { t } from "../i18n";
import { errorCodeOf } from "../terminal/reconnect";
import { TunnelReconnects } from "./tunnelReconnect";
import {
  forwardIdsToRun,
  isConnectionChanged,
  isForwardEdited,
  isJumpHostLost,
  listeningForwardCount,
  runChoiceOf,
  runningInOrder,
  tunnelableDevices,
  type DeviceTunnelState,
  type TunnelRunState,
} from "./tunnelForwards";
import { TunnelRegistry } from "./tunnelRegistry";
import { TunnelRunMemory } from "./tunnelRunMemory";
import { DeviceCallQueue } from "./deviceCallQueue";
import { renderTunnelCards, makeTunnelCardShell, type TunnelCardActions } from "./tunnelCardView";

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

/** Who asked for a tunnel start: launch or a restart, a user click
 * (remembered once accepted), or an auto-reconnect. */
type StartMode = "auto" | "manual" | "reconnect";

export class TunnelsPanel {
  private devices: Device[] = [];
  private readonly registry = new TunnelRegistry();
  private readonly memory: TunnelRunMemory;
  private readonly calls = new DeviceCallQueue();
  private readonly reconnects = new TunnelReconnects((deviceId) => this.reconnect(deviceId));
  private unlisten: UnlistenFn | null = null;
  private readonly container: HTMLElement | null;
  private body: HTMLElement | null = null;
  private readonly actions: TunnelCardActions = {
    startAll: (device) => this.startAll(device),
    stopAll: (deviceId) => this.stopAll(deviceId),
    startForward: (deviceId, forwardId) => this.startForward(deviceId, forwardId),
    stopForward: (deviceId, forwardId) => this.stopForward(deviceId, forwardId),
    copy: (text) => void this.copyEndpoint(text),
  };

  constructor(private readonly options: TunnelsPanelOptions = {}) {
    // The sidebar card container (mirrors how the device/profile managers bind
    // to their `.device-list` / `.profile-list` sections).
    this.container = document.querySelector<HTMLElement>(".tunnel-list");
    this.memory = new TunnelRunMemory(options.initialState, () => this.options.onPersist?.());
  }

  async init(): Promise<void> {
    this.buildCard();
    this.adoptLaunchDevices(await this.safeListDevices());
    await this.adoptRunningTunnels();
    this.subscribe();
    this.render();
    await this.autoStartFlagged();
  }

  /** A failed load is not "no devices": it leaves the remembered state
   * unpruned, and the list a refresh may have loaded meanwhile. */
  private adoptLaunchDevices(devices: Device[] | null): void {
    if (!devices) return;
    this.devices = devices;
    this.memory.markLoaded();
  }

  /**
   * Start the forwards that should run at launch (see `forwardIdsToRun`).
   * Sequential so a burst of failures surfaces as individual toasts rather
   * than all at once.
   */
  private async autoStartFlagged(): Promise<void> {
    for (const device of tunnelableDevices(this.devices)) await this.autoStart(device);
  }

  /** Unless the device's tunnel is already running (adopted at launch). */
  private async autoStart(device: SshDevice): Promise<void> {
    const ids = forwardIdsToRun(device, this.memory.choiceFor(device.id));
    if (ids.length > 0 && !this.registry.findState(device.id)) await this.startTunnelWith(device.id, ids, "auto");
  }

  /** The remembered run state to persist, limited to devices that still have
   * forwards; `undefined` when there is nothing to remember. */
  layoutState(): TunnelRunState | undefined {
    return this.memory.stateFor(tunnelableDevices(this.devices));
  }

  /** Remember `running` as the device's forwards to keep running. */
  private rememberRunning(deviceId: string, running: Set<string>): void {
    const device = this.tunnelable(deviceId);
    if (device) this.memory.remember(deviceId, runChoiceOf(device, running));
  }

  /** Refresh the device list (called when devices are added/edited/deleted). */
  setDevices(devices: Device[]): void {
    const previous = this.devices;
    this.devices = devices;
    this.memory.markLoaded();
    this.stopOrphans();
    this.releaseDeletedForwards();
    this.applyEdits(previous);
    this.render();
  }

  /** Stop every running tunnel whose device was deleted or no longer has
   * forwards — its row is gone, so nothing else could ever stop it. */
  private stopOrphans(): void {
    for (const [deviceId, state] of this.registry.entries()) {
      if (!this.tunnelable(deviceId)) void this.requestStop(deviceId, state.tunnelId);
    }
  }

  /** Release running forwards deleted from their (still tunnelable) device —
   * their rows are gone, so nothing else could ever stop them. */
  private releaseDeletedForwards(): void {
    for (const [deviceId, state] of this.registry.entries()) {
      const device = this.tunnelable(deviceId);
      if (device) this.releaseMissing(device, state);
    }
  }

  private releaseMissing(device: SshDevice, state: DeviceTunnelState): void {
    const existing = new Set(device.forwards.map((f) => f.id));
    const missing = [...state.requested].filter((id) => !existing.has(id));
    for (const id of missing) {
      state.requested.delete(id);
      if (!this.registry.isDeferred(state.tunnelId)) void this.sendStopForward(device.id, state, id);
    }
  }

  /** Restart tunnels whose device's connection settings were edited, and
   * re-bind running forwards that were edited. */
  private applyEdits(previous: Device[]): void {
    for (const [deviceId, state] of this.registry.entries()) this.applyEditTo(previous, deviceId, state);
  }

  private applyEditTo(previous: Device[], deviceId: string, state: DeviceTunnelState): void {
    const before = tunnelableDevices(previous).find((d) => d.id === deviceId);
    const after = this.tunnelable(deviceId);
    if (before && after) this.applyEdit(before, after, state);
  }

  private applyEdit(before: SshDevice, after: SshDevice, state: DeviceTunnelState): void {
    if (state.requested.size === 0) return;
    if (isJumpHostLost(before, after)) {
      this.stopForLostJumpHost(after);
      return;
    }
    this.applyConnectionEdit(before, after, state);
  }

  private applyConnectionEdit(before: SshDevice, after: SshDevice, state: DeviceTunnelState): void {
    if (isConnectionChanged(before, after)) {
      this.restart(after.id, state);
      return;
    }
    this.rebindEdited(before, after, state);
  }

  private rebindEdited(before: SshDevice, after: SshDevice, state: DeviceTunnelState): void {
    for (const id of state.requested) {
      if (isForwardEdited(before, after, id)) this.bindForward(after.id, state, id);
    }
  }

  /** Restarting would now reach the target directly, so stop the tunnel
   * instead and say why. */
  private stopForLostJumpHost(device: SshDevice): void {
    this.stopAll(device.id);
    this.options.onError?.({
      code: "Validation",
      message: t("tunnels.error.jumpRemoved", { name: device.name }),
    });
  }

  /** Stop the tunnel now; `onEnded` starts its replacement once it is gone. A
   * dropped tunnel waiting to reconnect needs nothing: it reopens with the new
   * settings. */
  private restart(deviceId: string, state: DeviceTunnelState): void {
    if (this.registry.waiting.has(state.tunnelId)) return;
    this.registry.restarting.add(state.tunnelId);
    state.status = "connecting";
    state.forwards = [];
    void this.requestStop(deviceId, state.tunnelId);
  }

  private tunnelable(deviceId: string): SshDevice | undefined {
    return tunnelableDevices(this.devices).find((d) => d.id === deviceId);
  }

  /** Stop a tunnel. Should the request fail, the forwards in `restore` are
   * shown running again — the tunnel still is. */
  private requestStop(
    deviceId: string,
    tunnelId: string,
    restore: Iterable<string> = [],
  ): Promise<void> {
    return this.calls.enqueue(deviceId, async () => {
      try {
        await stopTunnel(tunnelId);
      } catch (err) {
        this.restoreRequested(deviceId, tunnelId, restore);
        this.reportError(err);
      }
    });
  }

  /** Mark forwards running again after a stop request failed. */
  private restoreRequested(deviceId: string, tunnelId: string, ids: Iterable<string>): void {
    const state = this.registry.findCurrentState(deviceId, tunnelId);
    if (!state) return;
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
    this.reconnects.dispose();
  }

  private reportError(err: unknown): void {
    this.options.onError?.(err as AppError);
  }

  /** The device list, or `null` when it couldn't be loaded (error toasted). */
  private async safeListDevices(): Promise<Device[] | null> {
    try {
      return await listDevices();
    } catch (err) {
      this.reportError(err);
      return null;
    }
  }

  /** Reflect tunnels already running (e.g. after a UI reload), including ones
   * still connecting, which report the forwards they will bind. A failed
   * listing is non-fatal: the panel just starts with nothing marked running. */
  private async adoptRunningTunnels(): Promise<void> {
    const running = await listTunnels().catch((): TunnelInfo[] => []);
    for (const tunnel of running) this.adoptTunnel(tunnel);
  }

  private adoptTunnel({ tunnelId, deviceId, forwardIds, forwards }: TunnelInfo): void {
    this.registry.track(deviceId, {
      tunnelId,
      status: forwards.length > 0 ? "listening" : "connecting",
      requested: new Set(forwardIds),
      forwards,
    });
  }

  private subscribe(): void {
    void onTunnelStatus((event) => this.onStatus(event)).then((unlisten) => {
      this.unlisten = unlisten;
    });
  }

  private onStatus(event: TunnelStatusEvent): void {
    const deviceId = this.registry.findDevice(event.tunnelId);
    if (!deviceId) return;
    if (isEnded(event.status)) this.onEnded(deviceId, event);
    else this.applyLive(deviceId, event);
    this.render();
  }

  /** A tunnel ended: start its replacement if it was stopped to restart, else
   * wait to reopen it if it dropped on its own, else forget it (reporting an
   * error). */
  private onEnded(deviceId: string, event: TunnelStatusEvent): void {
    const restartWith = this.takeRestart(deviceId, event.tunnelId);
    if (restartWith.length > 0) {
      this.endTunnel(deviceId, event);
      void this.startTunnelWith(deviceId, restartWith, "auto");
      return;
    }
    if (!this.waitToReconnect(deviceId, event.tunnelId, event.code)) this.endTunnel(deviceId, event);
  }

  private endTunnel(deviceId: string, event: TunnelStatusEvent): void {
    this.registry.forget(deviceId, event.tunnelId);
    if (event.status === "error") this.reportTunnelError(event);
  }

  private reportTunnelError(event: TunnelStatusEvent): void {
    this.options.onError?.({
      code: "TunnelBind",
      message: event.message ?? t("tunnels.error.generic"),
    });
  }

  /** The forwards a restarting tunnel's replacement should carry — what the
   * user still wants, among the forwards the device still has. */
  private takeRestart(deviceId: string, tunnelId: string): string[] {
    if (!this.registry.restarting.delete(tunnelId)) return [];
    return this.wantedForwards(deviceId, this.registry.findCurrentState(deviceId, tunnelId)?.requested);
  }

  /** Keep a tunnel that dropped while still wanted, showing it as connecting
   * until it is reopened; `false` when it should stay down. */
  private waitToReconnect(deviceId: string, tunnelId: string, code?: ErrorCode): boolean {
    const device = this.droppedWhileWanted(deviceId, tunnelId);
    if (!device || !this.reconnects.schedule(deviceId, device.autoReconnect, code)) return false;
    const state = this.registry.findState(deviceId)!;
    state.status = "connecting";
    state.forwards = [];
    this.registry.waiting.add(tunnelId);
    this.registry.unroute(tunnelId);
    return true;
  }

  /** The device, if `tunnelId` is its current tunnel and still carries forwards
   * the user wants (a Stop clears them first). */
  private droppedWhileWanted(deviceId: string, tunnelId: string): SshDevice | undefined {
    const state = this.registry.findCurrentState(deviceId, tunnelId);
    if (!state || state.requested.size === 0) return undefined;
    return this.tunnelable(deviceId);
  }

  /** Reopen a dropped tunnel with the forwards the user still wants; none left
   * (all stopped meanwhile, or the device deleted) leaves it stopped. */
  private reconnect(deviceId: string): void {
    const state = this.registry.findState(deviceId);
    if (!state || !this.registry.waiting.delete(state.tunnelId)) return;
    this.registry.forget(deviceId, state.tunnelId);
    this.reopen(deviceId, state.requested);
    this.render();
  }

  private reopen(deviceId: string, requested: Set<string>): void {
    const ids = this.wantedForwards(deviceId, requested);
    if (ids.length > 0) void this.startTunnelWith(deviceId, ids, "reconnect");
    else this.reconnects.reset(deviceId);
  }

  /** The device's forwards among `requested`, in its order (none once it is
   * deleted or lost its forwards). */
  private wantedForwards(deviceId: string, requested: Set<string> | undefined): string[] {
    const device = this.tunnelable(deviceId);
    return device && requested ? runningInOrder(device, requested) : [];
  }

  /** Record a `connecting` / `listening` status on the device's tunnel. */
  private applyLive(deviceId: string, event: TunnelStatusEvent): void {
    const state = this.findLiveState(deviceId, event.tunnelId);
    if (!state) return;
    state.status = event.status;
    if (event.status === "listening") this.applyListening(deviceId, state, event.forwards);
  }

  /** The tunnel's state, unless it was replaced or is being restarted (which
   * keeps showing connecting). */
  private findLiveState(deviceId: string, tunnelId: string): DeviceTunnelState | undefined {
    if (this.registry.restarting.has(tunnelId)) return undefined;
    return this.registry.findCurrentState(deviceId, tunnelId);
  }

  /** The tunnel is up: its next drop gets a full reconnect budget. */
  private applyListening(deviceId: string, state: DeviceTunnelState, forwards: ForwardStatus[]): void {
    state.forwards = forwards;
    this.reconnects.reset(deviceId);
  }

  /* ----- user actions ----------------------------------------------------- */

  private startAll(device: SshDevice): void {
    void this.startTunnelWith(
      device.id,
      device.forwards.map((f) => f.id),
      "manual",
    );
  }

  private stopAll(deviceId: string): void {
    const state = this.registry.findActiveState(deviceId);
    if (!state) return;
    const previous = [...state.requested];
    state.requested.clear();
    this.rememberRunning(deviceId, state.requested);
    this.cancelReconnect(deviceId);
    this.render();
    void this.requestStop(deviceId, state.tunnelId, previous);
  }

  /** The user took over: drop a pending reconnect and the tunnel shown
   * waiting for it. */
  private cancelReconnect(deviceId: string): void {
    this.reconnects.reset(deviceId);
    const state = this.registry.findState(deviceId);
    if (state && this.registry.waiting.delete(state.tunnelId)) this.registry.forget(deviceId, state.tunnelId);
  }

  /** Start one forward: on the device's running tunnel, else on a new one. */
  private startForward(deviceId: string, forwardId: string): void {
    const state = this.registry.findActiveState(deviceId);
    if (!state) {
      void this.startTunnelWith(deviceId, [forwardId], "manual");
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
    if (!this.registry.isDeferred(state.tunnelId)) {
      void this.sendStartForward(deviceId, state.tunnelId, forwardId);
    }
  }

  /** Stop one forward; the last one stops the whole tunnel. */
  private stopForward(deviceId: string, forwardId: string): void {
    const state = this.registry.findActiveState(deviceId);
    if (!state) return;
    state.requested.delete(forwardId);
    this.rememberRunning(deviceId, state.requested);
    this.render();
    if (!this.registry.isDeferred(state.tunnelId)) {
      void this.sendStopForward(deviceId, state, forwardId);
    }
  }

  private sendStartForward(deviceId: string, tunnelId: string, forwardId: string): Promise<void> {
    return this.calls.enqueue(deviceId, async () => {
      try {
        await startTunnelForward(tunnelId, forwardId);
      } catch (err) {
        this.dropRequested(deviceId, tunnelId, forwardId);
        this.reportError(err);
      }
    });
  }

  /** Un-ask a forward the backend refused to bind (it shows stopped again). */
  private dropRequested(deviceId: string, tunnelId: string, forwardId: string): void {
    const state = this.registry.findCurrentState(deviceId, tunnelId);
    if (!state) return;
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
    return this.calls.enqueue(deviceId, async () => {
      try {
        await stopTunnelForward(state.tunnelId, forwardId);
      } catch (err) {
        this.restoreRequested(deviceId, state.tunnelId, [forwardId]);
        this.reportError(err);
      }
    });
  }

  /**
   * Open a device's tunnel carrying `forwardIds`. A start the backend rejects
   * outright is a configuration problem (not a flaky network), so it is
   * remembered as stopped rather than retried — and failing — on every launch;
   * only an automatic reconnect retries one that may pass (e.g. a keychain not
   * unlocked yet).
   */
  private async startTunnelWith(deviceId: string, forwardIds: string[], mode: StartMode): Promise<void> {
    if (mode === "manual") this.cancelReconnect(deviceId);
    // The id is chosen here so status events (which can beat the command's
    // return) route to this row, and Stop works while the start is in flight.
    const tunnelId = crypto.randomUUID();
    this.trackStarting(deviceId, tunnelId, forwardIds);
    try {
      await startTunnel(deviceId, tunnelId, forwardIds);
      this.registry.starting.delete(tunnelId);
      this.afterStarted(deviceId, tunnelId, forwardIds, mode === "manual");
    } catch (err) {
      this.registry.starting.delete(tunnelId);
      this.onStartRejected(deviceId, tunnelId, err, mode === "reconnect");
    }
  }

  /** Optimistically mark connecting so the row reflects the click immediately. */
  private trackStarting(deviceId: string, tunnelId: string, forwardIds: string[]): void {
    this.registry.track(deviceId, {
      tunnelId,
      status: "connecting",
      requested: new Set(forwardIds),
      forwards: [],
    });
    this.render();
    this.registry.starting.add(tunnelId);
  }

  /** The backend refused to open the tunnel: wait to retry a reconnect that
   * may yet pass, else give up and say why. */
  private onStartRejected(
    deviceId: string,
    tunnelId: string,
    err: unknown,
    reconnecting: boolean,
  ): void {
    if (reconnecting && this.waitToReconnect(deviceId, tunnelId, errorCodeOf(err))) {
      this.render();
      return;
    }
    this.dropRejectedStart(deviceId, tunnelId, reconnecting);
    this.reportError(err);
  }

  private dropRejectedStart(deviceId: string, tunnelId: string, reconnecting: boolean): void {
    this.registry.forget(deviceId, tunnelId);
    // A reconnect that fails for good is not the user stopping the tunnel: the
    // next launch still restores it.
    if (!reconnecting) this.memory.remember(deviceId, false);
    this.render();
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
    const state = this.registry.findCurrentState(deviceId, tunnelId);
    if (!state) {
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
      this.registry.restarting.has(state.tunnelId)
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
    this.container.innerHTML = makeTunnelCardShell();
    this.body = this.container.querySelector<HTMLElement>(".tunnel-list-items");
  }

  /** How many forwards are listening right now (the side menu's chip), on
   * the devices the card shows: a deleted device's tunnel can linger until the
   * backend confirms its stop, or for good if the stop failed. */
  listeningForwardCount(): number {
    const shown = tunnelableDevices(this.devices).map((device) => this.registry.findState(device.id));
    return listeningForwardCount(shown.filter((state) => state !== undefined));
  }

  private render(): void {
    this.options.onForwardsChange?.();
    if (!this.body) return;
    renderTunnelCards(this.body, tunnelableDevices(this.devices), (id) => this.registry.findActiveState(id), this.actions);
  }
}

function isEnded(status: TunnelStatus): boolean {
  return status === "disconnected" || status === "error";
}

/** Constructs and initializes the Tunnels panel. */
export function initTunnelsPanel(
  options: TunnelsPanelOptions = {},
): TunnelsPanel {
  const panel = new TunnelsPanel(options);
  void panel.init();
  return panel;
}
