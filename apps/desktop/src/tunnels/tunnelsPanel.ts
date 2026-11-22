/**
 * The Tunnels sidebar card (SPEC tunnels §6): a section under Devices listing
 * every SSH device that has port forwards with a Start all / Stop all control,
 * a live status icon, and per-forward rows (status dot, name over
 * `local → remote`, copy-endpoint, and the forward's own Start/Stop). It is
 * intentionally separate from the terminal grid — a tunnel has no terminal and
 * is long-lived — so `grid.ts` / `pane.ts` are untouched.
 *
 * The panel only renders: `tunnelSupervisor` runs the tunnels, the panel
 * redraws the cards (`tunnelCardView`) whenever it reports a change, and passes
 * the cards' clicks back to it.
 */

import type { AppError } from "../ipc";
import { t } from "../i18n";
import { TunnelSupervisor } from "./tunnelSupervisor";
import { ipcTunnelsPort, type TunnelsPort } from "./tunnelsPort";
import type { TunnelRunState } from "./tunnelForwards";
import type { DeviceCatalog } from "../devices/deviceCatalog";
import { renderTunnelCards, makeTunnelCardShell, type TunnelCardActions } from "./tunnelCardView";

export interface TunnelsPanelOptions {
  /** The window's device list; device edits reach the tunnels through it. */
  catalog: DeviceCatalog;
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

export class TunnelsPanel {
  private readonly supervisor: TunnelSupervisor;
  private readonly container: HTMLElement | null;
  private body: HTMLElement | null = null;
  private readonly actions: TunnelCardActions = {
    startAll: (device) => this.supervisor.startDevice(device),
    stopAll: (deviceId) => this.supervisor.stopDevice(deviceId),
    startForward: (deviceId, forwardId) => this.supervisor.startForward(deviceId, forwardId),
    stopForward: (deviceId, forwardId) => this.supervisor.stopForward(deviceId, forwardId),
    copy: (text) => void this.copyEndpoint(text),
  };

  constructor(
    private readonly options: TunnelsPanelOptions,
    port: TunnelsPort = ipcTunnelsPort,
  ) {
    // The sidebar card container (mirrors how the device/profile managers bind
    // to their `.device-list` / `.profile-list` sections).
    this.container = document.querySelector<HTMLElement>(".tunnel-list");
    const { catalog, onError, initialState, onPersist } = options;
    this.supervisor = new TunnelSupervisor(port, catalog, { onError, initialState, onPersist });
    this.supervisor.onChanged(() => this.render());
  }

  async init(): Promise<void> {
    this.buildCard();
    await this.supervisor.init();
  }

  /** The remembered run state to persist (see `TunnelSupervisor.layoutState`). */
  layoutState(): TunnelRunState | undefined {
    return this.supervisor.layoutState();
  }

  /** How many forwards are listening right now (the side menu's chip). */
  listeningForwardCount(): number {
    return this.supervisor.listeningForwardCount();
  }

  /** Rebuild the card shell + rows in the current locale (language change). */
  retranslate(): void {
    this.buildCard();
    this.render();
  }

  /** Stop listening — used by tests; the app keeps the panel for its lifetime. */
  dispose(): void {
    this.supervisor.dispose();
  }

  private async copyEndpoint(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.options.onSuccess?.(t("tunnels.copied"));
    } catch {
      // Clipboard blocked/unavailable — silent; the text is still on screen.
    }
  }

  /** Render the sidebar card shell (header + list body) into `.tunnel-list`. */
  private buildCard(): void {
    if (!this.container) return;
    this.container.innerHTML = makeTunnelCardShell();
    this.body = this.container.querySelector<HTMLElement>(".tunnel-list-items");
  }

  private render(): void {
    this.options.onForwardsChange?.();
    if (!this.body) return;
    renderTunnelCards(this.body, this.supervisor.tunnelableDevices(), (id) => this.supervisor.activeState(id), this.actions);
  }
}

/** Constructs and initializes the Tunnels panel. */
export function initTunnelsPanel(options: TunnelsPanelOptions): TunnelsPanel {
  const panel = new TunnelsPanel(options);
  void panel.init();
  return panel;
}
