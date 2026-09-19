/**
 * The Files (SFTP) feature: a persistent, resizable browser **panel** docked to
 * the right of the terminal grid (built into the `.sftp-panel` aside in
 * `index.html`), opened from the header toggle. A device picker in the panel
 * header chooses which SSH device to browse. Intentionally separate from the
 * terminal grid — an SFTP browse has no terminal.
 *
 * Connection lifecycle (the point of the panel over the old modal drawer):
 * selecting a device connects and lists its home directory; the connection then
 * stays alive while you work in a terminal beside it. Three states gate the two
 * safety nets that keep an idle SSH session from leaking:
 *   - expanded  → connected, actively browsing;
 *   - collapsed → connected but set aside; an idle timer (from settings, 0 =
 *     off) disconnects it after N minutes;
 *   - hidden    → fully closed (header toggle off, or the × / Disconnect), which
 *     disconnects immediately.
 * Switching the device picker disconnects the previous device before connecting
 * the new one (one live browse at a time; the backend keys connections by id).
 *
 * Remote paths are POSIX; see `sftpFormat.ts` for the path/size/time helpers.
 */

import {
  listDevices,
  sftpConnect,
  sftpDisconnect,
  sftpDownload,
  sftpList,
  sftpMkdir,
  sftpRealpath,
  sftpRemove,
  sftpRename,
  sftpUpload,
  sftpCancelTransfer,
  onSftpProgress,
  type AppError,
  type Device,
  type SftpEntry,
  type SftpPanelState,
  type SftpProgressEvent,
  type SshDevice,
} from "../ipc";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  pickDownloadSavePath,
  pickUploadOpenPath,
} from "../ui/fileDialog";
import { confirm, prompt } from "../ui/confirm";
import {
  trashIcon,
  pencilIcon,
  arrowUpIcon,
  copyIcon,
  arrowLeftIcon,
  arrowRightIcon,
  reloadIcon,
  uploadIcon,
  downloadIcon,
  folderPlusIcon,
  chevronLeftIcon,
  chevronRightIcon,
  disconnectIcon,
} from "../ui/icons";
import { joinRemote, parentOf, formatSize, formatMtime } from "./sftpFormat";
import { basename } from "@tauri-apps/api/path";
import { t, tp } from "../i18n";

export interface SftpPanelOptions {
  onError?: (error: AppError) => void;
  onSuccess?: (message: string) => void;
  /**
   * Current idle-disconnect timeout in minutes (`0` disables it), read each time
   * the panel collapses so it always arms the latest setting. Wired to the
   * settings controller in `main.ts`.
   */
  getIdleDisconnectMins?: () => number;
  /**
   * Fired whenever the panel's presence or width changes (open/close/collapse/
   * resize), so the caller can re-fit the terminal grid whose width just changed.
   */
  onLayoutChange?: () => void;
  /**
   * Fired when the panel's persisted state changes (open/collapse/resize-end/
   * device switch), so the caller can schedule a workspace save. Not fired
   * during a drag (only on drag end) to avoid a write per mouse move.
   */
  onPersist?: () => void;
  /** The panel's persisted state to restore on startup (open/collapsed/width +
   * last device). Applied at the end of `init`; never auto-reconnects. */
  initialState?: SftpPanelState;
}

/** The SSH devices — the only ones that can be browsed over SFTP. */
export function browsableDevices(devices: Device[]): SshDevice[] {
  return devices.filter((d): d is SshDevice => d.kind === "ssh");
}

/** Panel width bounds (px). The upper bound is also clamped to a fraction of the
 * workspace at drag time so the grid never disappears. */
const MIN_PANEL_WIDTH = 260;
const DEFAULT_PANEL_WIDTH = 360;
/** Absolute upper bound for a restored width (the live drag re-clamps against
 * the workspace row so the grid never disappears). */
const MAX_PANEL_WIDTH = 2000;
/** The grid keeps at least this much of the workspace row when dragging. */
const MIN_GRID_WIDTH = 240;

export class SftpPanel {
  private devices: Device[] = [];

  /** The docked panel + its resize splitter (both live in `index.html`). */
  private panel: HTMLElement | null;
  private splitter: HTMLElement | null;
  private deviceSelectEl: HTMLSelectElement | null = null;
  private connDotEl: HTMLElement | null = null;
  private connToggleEl: HTMLButtonElement | null = null;
  private pathEl: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private progressIconEl: HTMLElement | null = null;
  private progressFillEl: HTMLElement | null = null;
  private progressPctEl: HTMLElement | null = null;

  /** `sftp_progress` event subscription (live while the panel exists). */
  private unlistenProgress: UnlistenFn | null = null;
  /** Timer that hides the completed-progress row after a short delay. */
  private progressHideTimer: ReturnType<typeof setTimeout> | null = null;
  /** Idle-disconnect timer, armed while collapsed + connected. */
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  /** The device whose connection the panel is currently showing (null when not
   * connected). */
  private activeDeviceId: string | null = null;
  /** The device chosen in the picker (may be selected but not yet connected, or
   * remembered across an idle/explicit disconnect for a one-click reconnect). */
  private selectedDeviceId: string | null = null;
  /** True after an idle-timeout disconnect, so the disconnected state can say so. */
  private idleDisconnected = false;
  /** Panel visibility + collapse state. */
  private panelOpen = false;
  private collapsed = false;
  /** True once the panel has been opened at least once (this session or a
   * restored state), gating whether its state is persisted at all. */
  private everOpened = false;
  /** Current panel width in px (persisted by the caller via `layoutState`). */
  private width = DEFAULT_PANEL_WIDTH;

  /** The directory currently listed. */
  private cwd = "/";
  /** Visited-directory stack for Back/Forward (see `goTo`/`goBack`). */
  private history: string[] = [];
  private historyIndex = -1;
  /** True while a connect/list/transfer is in flight (disables the toolbar). */
  private busy = false;

  /** Splitter drag state; non-null only while the handle is held. */
  private drag: { startX: number; startWidth: number } | null = null;
  /** The splitter lives outside the panel's replaced innerHTML, so its listener
   * survives a `buildPanel()` rebuild — wire it exactly once. */
  private splitterWired = false;

  constructor(private readonly options: SftpPanelOptions = {}) {
    this.panel = document.querySelector<HTMLElement>(".sftp-panel");
    this.splitter = document.querySelector<HTMLElement>(".sftp-splitter");
  }

  async init(): Promise<void> {
    this.buildPanel();
    this.devices = await this.safeListDevices();
    this.refreshDeviceSelect();
    this.applyInitialState();
  }

  /**
   * Restore the persisted panel state (open/collapsed/width + preselected
   * device). Never connects — a restored device is only preselected, so a
   * restart doesn't silently re-authenticate; the disconnected state offers a
   * one-click Reconnect.
   */
  private applyInitialState(): void {
    const s = this.options.initialState;
    if (!s) return;
    this.width = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, s.width));
    const known = s.deviceId && browsableDevices(this.devices).some((d) => d.id === s.deviceId);
    this.selectedDeviceId = known ? s.deviceId : null;
    if (!s.open) return;
    this.everOpened = true;
    this.panelOpen = true;
    this.collapsed = s.collapsed;
    this.applyOpenState();
    this.syncDeviceSelect();
    this.renderDisconnectedState();
    this.options.onLayoutChange?.();
  }

  /** The persisted panel state, or `undefined` until the panel has been opened
   * (so the workspace file stays clean until the feature is used). */
  layoutState(): SftpPanelState | undefined {
    if (!this.everOpened) return undefined;
    return {
      open: this.panelOpen,
      collapsed: this.collapsed,
      width: this.width,
      deviceId: this.activeDeviceId ?? this.selectedDeviceId ?? null,
    };
  }

  /** Notify the caller that persisted state changed (debounced save). */
  private persist(): void {
    this.options.onPersist?.();
  }

  /** Re-fetch devices and refresh the picker (device CRUD happened). */
  async refresh(): Promise<void> {
    this.devices = await this.safeListDevices();
    this.refreshDeviceSelect();
    // The active device may have been deleted out from under us.
    if (this.activeDeviceId && !this.devices.some((d) => d.id === this.activeDeviceId)) {
      await this.handleDisconnect();
    }
  }

  /**
   * Rebuild the panel chrome in the current locale (language change), but only
   * while not connected: tearing down a live browse would be surprising, and a
   * language change is initiated from the settings dialog.
   */
  retranslate(): void {
    if (!this.activeDeviceId) {
      this.unlistenProgress?.();
      this.unlistenProgress = null;
      this.buildPanel();
      this.refreshDeviceSelect();
      if (this.panelOpen) this.applyOpenState();
    }
  }

  /** Stop listening for progress events + clear timers (tests; the app keeps the
   * panel for its lifetime). */
  dispose(): void {
    this.unlistenProgress?.();
    this.unlistenProgress = null;
    this.clearHideTimer();
    this.clearIdleTimer();
  }

  private async safeListDevices(): Promise<Device[]> {
    try {
      return await listDevices();
    } catch (err) {
      this.options.onError?.(err as AppError);
      return [];
    }
  }

  /* ----- panel shell ------------------------------------------------------ */

  private buildPanel(): void {
    const panel = this.panel;
    if (!panel) return;
    panel.innerHTML = `
      <div class="sftp-rail">
        <button type="button" class="btn btn-icon" data-action="expand"
          title="${t("sftp.expand")}" aria-label="${t("sftp.expand")}">${chevronLeftIcon}</button>
        <span class="sftp-conn-dot" aria-hidden="true"></span>
      </div>
      <div class="sftp-panel-body">
        <div class="sftp-panel-header">
          <span class="sftp-panel-title">${t("sftp.panelTitle")}</span>
          <select class="sftp-device-select" aria-label="${t("sftp.selectDevice")}"></select>
          <div class="sftp-panel-header-actions">
            <button type="button" class="btn btn-icon sftp-conn-toggle" data-action="conn-toggle"
              title="${t("sftp.disconnect")}" aria-label="${t("sftp.disconnect")}">${disconnectIcon}</button>
            <button type="button" class="btn btn-icon" data-action="collapse"
              title="${t("sftp.collapse")}" aria-label="${t("sftp.collapse")}">${chevronRightIcon}</button>
            <button type="button" class="btn btn-icon" data-action="hide"
              title="${t("common.close")}" aria-label="${t("common.close")}">&times;</button>
          </div>
        </div>
        <div class="sftp-toolbar">
          <input type="text" class="sftp-path" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="${t("sftp.path.aria")}" title="${t("sftp.path.edit")}" />
          <div class="sftp-toolbar-actions">
            <button type="button" class="btn btn-icon" data-action="copy-path" title="${t("sftp.nav.copyPath")}" aria-label="${t("sftp.nav.copyPath")}">${copyIcon}</button>
            <button type="button" class="btn btn-icon" data-action="back" title="${t("sftp.nav.back")}" aria-label="${t("sftp.nav.back")}">${arrowLeftIcon}</button>
            <button type="button" class="btn btn-icon" data-action="forward" title="${t("sftp.nav.forward")}" aria-label="${t("sftp.nav.forward")}">${arrowRightIcon}</button>
            <button type="button" class="btn btn-icon" data-action="up" title="${t("sftp.nav.up")}" aria-label="${t("sftp.nav.up")}">${arrowUpIcon}</button>
            <button type="button" class="btn btn-icon" data-action="refresh" title="${t("sftp.nav.refresh")}" aria-label="${t("sftp.nav.refresh")}">${reloadIcon}</button>
            <button type="button" class="btn btn-icon" data-action="upload" title="${t("sftp.nav.upload")}" aria-label="${t("sftp.nav.upload")}">${uploadIcon}</button>
            <button type="button" class="btn btn-icon" data-action="mkdir" title="${t("sftp.nav.mkdir")}" aria-label="${t("sftp.nav.mkdir")}">${folderPlusIcon}</button>
          </div>
        </div>
        <div class="sftp-entries" role="list"></div>
        <div class="sftp-progress" role="status" aria-live="polite">
          <span class="sftp-progress-icon" aria-hidden="true"></span>
          <div class="sftp-progress-track"><div class="sftp-progress-fill"></div></div>
          <span class="sftp-progress-pct"></span>
          <button type="button" class="btn btn-icon sftp-progress-cancel" data-action="cancel-transfer" title="${t("sftp.cancelTransfer")}" aria-label="${t("sftp.cancelTransfer")}">&times;</button>
        </div>
        <div class="sftp-status" aria-live="polite"></div>
      </div>
    `;

    this.deviceSelectEl = panel.querySelector(".sftp-device-select");
    this.connDotEl = panel.querySelector(".sftp-conn-dot");
    this.connToggleEl = panel.querySelector(".sftp-conn-toggle");
    this.pathEl = panel.querySelector(".sftp-path");
    this.listEl = panel.querySelector(".sftp-entries");
    this.statusEl = panel.querySelector(".sftp-status");
    this.progressEl = panel.querySelector(".sftp-progress");
    this.progressIconEl = panel.querySelector(".sftp-progress-icon");
    this.progressFillEl = panel.querySelector(".sftp-progress-fill");
    this.progressPctEl = panel.querySelector(".sftp-progress-pct");

    this.pathEl?.addEventListener("keydown", (e) => {
      const ev = e as KeyboardEvent;
      if (ev.key === "Enter") {
        ev.preventDefault();
        if (!this.busy) void this.goToPath(this.pathEl?.value ?? "");
      } else if (ev.key === "Escape") {
        ev.stopPropagation();
        this.syncPathInput();
        this.pathEl?.blur();
      }
    });

    this.deviceSelectEl?.addEventListener("change", () => {
      const id = this.deviceSelectEl?.value ?? "";
      if (id) void this.selectDevice(id);
    });

    panel.addEventListener("click", (e) => {
      const target = e.target;
      // Use `Element` (not `HTMLElement`): a click on a button's inline SVG has
      // an `SVGElement` target; `closest` still resolves the enclosing button.
      if (!(target instanceof Element)) return;
      const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
      switch (action) {
        case "hide":
          void this.hide();
          break;
        case "collapse":
          this.setCollapsed(true);
          break;
        case "expand":
          this.setCollapsed(false);
          break;
        case "conn-toggle":
          void this.handleConnToggle();
          break;
        case "copy-path":
          void this.handleCopyPath();
          break;
        case "back":
          if (!this.busy) void this.goBack();
          break;
        case "forward":
          if (!this.busy) void this.goForward();
          break;
        case "up":
          if (!this.busy) void this.goUp();
          break;
        case "refresh":
          if (!this.busy) void this.loadDir(this.cwd);
          break;
        case "upload":
          if (!this.busy) void this.handleUpload();
          break;
        case "mkdir":
          if (!this.busy) void this.handleMkdir();
          break;
        case "cancel-transfer":
          void this.handleCancelTransfer();
          break;
      }
    });

    this.wireSplitter();

    // Live transfer progress (throttled events from the backend).
    void onSftpProgress((e) => this.onProgress(e)).then((un) => {
      this.unlistenProgress = un;
    });
  }

  /* ----- open / collapse / hide (panel visibility) ------------------------ */

  /** Whether the panel is currently shown (open, expanded or collapsed). */
  isOpen(): boolean {
    return this.panelOpen;
  }

  /** Show the panel (expanded). Does not connect — the picker's disconnected
   * state offers a Connect button. */
  open(): void {
    this.panelOpen = true;
    this.everOpened = true;
    this.collapsed = false;
    this.idleDisconnected = false;
    this.applyOpenState();
    if (!this.activeDeviceId) this.renderDisconnectedState();
    this.options.onLayoutChange?.();
    this.persist();
  }

  /** Open the panel and connect to a specific device (sidebar "Browse"). */
  openWith(deviceId: string): void {
    this.open();
    void this.selectDevice(deviceId);
  }

  /** Toggle the panel from the header button: open when hidden, fully close
   * (disconnecting) when shown. */
  toggle(): void {
    if (this.panelOpen) void this.hide();
    else this.open();
  }

  /** Fully close the panel: disconnect the live connection immediately (the
   * "closed" state's rule) and hide the panel + splitter. */
  private async hide(): Promise<void> {
    this.panelOpen = false;
    this.clearIdleTimer();
    this.hideProgress();
    this.applyOpenState();
    this.options.onLayoutChange?.();
    this.persist();
    await this.disconnectActive();
    if (this.listEl) this.listEl.replaceChildren();
  }

  /** Collapse to the rail (keeps the connection, arms the idle timer) or expand
   * back (clears it). A no-op when the panel is hidden. */
  private setCollapsed(collapsed: boolean): void {
    if (!this.panelOpen) return;
    this.collapsed = collapsed;
    if (collapsed) this.armIdleTimer();
    else {
      this.clearIdleTimer();
      if (this.idleDisconnected && !this.activeDeviceId) this.renderDisconnectedState();
    }
    this.applyOpenState();
    this.options.onLayoutChange?.();
    this.persist();
  }

  /** Reflect open/collapsed/width onto the panel + splitter + toggle button. */
  private applyOpenState(): void {
    const panel = this.panel;
    if (!panel) return;
    panel.hidden = !this.panelOpen;
    panel.classList.toggle("sftp-collapsed", this.collapsed);
    // Clear the inline width while collapsed so the `.sftp-collapsed` rail width
    // (40px) applies; an inline width would otherwise override it.
    panel.style.width = this.collapsed ? "" : `${this.width}px`;
    if (this.splitter) this.splitter.hidden = !this.panelOpen || this.collapsed;
    this.updateConnDot();
    const btn = document.querySelector<HTMLButtonElement>("#sftp-btn");
    btn?.setAttribute("aria-pressed", String(this.panelOpen));
  }

  /* ----- connection lifecycle -------------------------------------------- */

  /**
   * Connect the panel to `deviceId`, disconnecting whatever it was showing.
   * `force` reconnects even when the id equals the (already-selected) device —
   * used by the Reconnect button after an idle/explicit disconnect.
   */
  private async selectDevice(deviceId: string, force = false): Promise<void> {
    if (!force && deviceId === this.activeDeviceId) return;
    if (this.activeDeviceId && this.activeDeviceId !== deviceId) {
      await this.disconnectActive();
    }
    this.selectedDeviceId = deviceId;
    this.syncDeviceSelect();
    this.idleDisconnected = false;
    this.history = [];
    this.historyIndex = -1;
    this.setStatus(t("sftp.connecting"));
    this.setBusy(true);
    try {
      // A first-contact host key raises the global host-key dialog; on accept the
      // connect proceeds and resolves here.
      const startDir = await sftpConnect(deviceId);
      this.activeDeviceId = deviceId;
      this.updateConnDot();
      await this.goTo(startDir);
    } catch (err) {
      this.activeDeviceId = null;
      this.setStatus("");
      this.options.onError?.(err as AppError);
      this.renderDisconnectedState();
      this.updateConnDot();
    } finally {
      this.setBusy(false);
      this.persist(); // remember the (now-)selected device
    }
  }

  /** Disconnect the live connection (if any) without touching panel visibility.
   * Idempotent and best-effort. */
  private async disconnectActive(): Promise<void> {
    const deviceId = this.activeDeviceId;
    this.activeDeviceId = null;
    if (deviceId) {
      try {
        await sftpDisconnect(deviceId);
      } catch {
        // Best-effort — the connection is torn down backend-side regardless.
      }
    }
  }

  /** The header connect/disconnect toggle: disconnect when connected, otherwise
   * connect the selected device (the replacement for the old Reconnect button). */
  private handleConnToggle(): void {
    if (this.activeDeviceId) {
      void this.handleDisconnect();
    } else if (this.selectedDeviceId) {
      void this.selectDevice(this.selectedDeviceId, true);
    }
  }

  /** Drop the connection but keep the panel open, showing the disconnected
   * state (the green toggle then offers connect/reconnect). */
  private async handleDisconnect(): Promise<void> {
    this.clearIdleTimer();
    this.idleDisconnected = false;
    await this.disconnectActive();
    this.hideProgress();
    this.setStatus("");
    this.syncPathInput();
    this.renderDisconnectedState();
    this.updateConnDot();
  }

  /* ----- idle timer ------------------------------------------------------- */

  /** Arm the idle-disconnect timer for a collapsed, connected panel (using the
   * live setting; `0` disables it). */
  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (!this.activeDeviceId) return;
    const mins = this.options.getIdleDisconnectMins?.() ?? 0;
    if (mins <= 0) return;
    this.idleTimer = setTimeout(() => void this.onIdleTimeout(), mins * 60_000);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Re-arm the idle timer if the setting changed while collapsed + connected. */
  onIdleSettingChange(): void {
    if (this.collapsed && this.activeDeviceId) this.armIdleTimer();
  }

  private async onIdleTimeout(): Promise<void> {
    this.idleTimer = null;
    if (!this.activeDeviceId) return;
    await this.disconnectActive();
    this.idleDisconnected = true;
    this.setStatus(t("sftp.idleDisconnected"));
    this.renderDisconnectedState();
    this.updateConnDot();
  }

  /* ----- navigation + operations ----------------------------------------- */

  /**
   * List `path` and render it as the current directory. Does NOT touch the
   * Back/Forward history — used for Refresh, post-operation re-listing, and as
   * the shared worker behind `goTo`/`goBack`/`goForward`.
   */
  private async loadDir(path: string): Promise<void> {
    if (this.activeDeviceId === null) return;
    this.setBusy(true);
    try {
      const entries = await sftpList(this.activeDeviceId, path);
      this.cwd = path;
      this.syncPathInput();
      this.renderEntries(entries);
      this.setStatus(tp("sftp.count", entries.length));
    } catch (err) {
      this.options.onError?.(err as AppError);
    } finally {
      this.setBusy(false); // also reconciles Back/Forward enabled state
    }
  }

  /**
   * Navigate to a new directory, recording it in history: truncate any forward
   * entries and push, then load it. Navigating to the current directory only
   * re-lists it.
   */
  private async goTo(path: string): Promise<void> {
    if (path === this.history[this.historyIndex]) {
      await this.loadDir(path);
      return;
    }
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(path);
    this.historyIndex = this.history.length - 1;
    await this.loadDir(path);
  }

  /** Reflect the current directory in the editable path input. */
  private syncPathInput(): void {
    if (this.pathEl) this.pathEl.value = this.activeDeviceId ? this.cwd : "";
  }

  /**
   * Navigate to a path typed into the path input. The path is canonicalized
   * server-side (resolving `..` and relative paths); if it turns out to be a
   * file rather than a directory, we open its parent folder instead.
   */
  private async goToPath(raw: string): Promise<void> {
    const deviceId = this.activeDeviceId;
    const input = raw.trim();
    if (deviceId === null || input === "") {
      this.syncPathInput();
      return;
    }
    let target: string;
    this.setBusy(true);
    try {
      const resolved = await sftpRealpath(deviceId, input);
      try {
        await sftpList(deviceId, resolved);
        target = resolved;
      } catch {
        // Not a listable directory — treat it as a file and open its parent,
        // resolving `..` server-side so the displayed path stays clean.
        target = await sftpRealpath(deviceId, parentOf(resolved));
      }
    } catch (err) {
      this.options.onError?.(err as AppError);
      this.syncPathInput();
      this.setBusy(false);
      return;
    }
    this.setBusy(false);
    await this.goTo(target);
  }

  /** Copy the current directory path to the clipboard. */
  private async handleCopyPath(): Promise<void> {
    if (!this.cwd || !this.activeDeviceId) return;
    try {
      await navigator.clipboard.writeText(this.cwd);
      this.options.onSuccess?.(t("sftp.pathCopied"));
    } catch (err) {
      this.options.onError?.(err as AppError);
    }
  }

  /** Step back to the previous directory in history (no-op at the start). */
  private async goBack(): Promise<void> {
    if (this.historyIndex <= 0) return;
    const target = this.history[this.historyIndex - 1];
    if (target === undefined) return;
    this.historyIndex -= 1;
    await this.loadDir(target);
  }

  /** Step forward to the next directory in history (no-op at the end). */
  private async goForward(): Promise<void> {
    if (this.historyIndex >= this.history.length - 1) return;
    const target = this.history[this.historyIndex + 1];
    if (target === undefined) return;
    this.historyIndex += 1;
    await this.loadDir(target);
  }

  private async goUp(): Promise<void> {
    if (this.activeDeviceId === null) return;
    try {
      // Resolve `<cwd>/..` server-side so symlinked paths go to the real parent.
      const parent = await sftpRealpath(this.activeDeviceId, parentOf(this.cwd));
      if (parent !== this.cwd) await this.goTo(parent);
    } catch (err) {
      this.options.onError?.(err as AppError);
    }
  }

  /** Clear the JS hover flag from every row. Called before opening a dialog so
   * the action buttons don't stay visible while a native dialog (which suppresses
   * `mouseleave`) is up. */
  private clearHover(): void {
    this.listEl
      ?.querySelectorAll(".sftp-entry.hovering")
      .forEach((el) => el.classList.remove("hovering"));
  }

  private async handleDownload(entry: SftpEntry): Promise<void> {
    if (this.activeDeviceId === null) return;
    this.clearHover();
    const local = await pickDownloadSavePath(entry.name);
    if (local === null) return; // cancelled
    const remote = joinRemote(this.cwd, entry.name);
    this.setBusy(true);
    this.setStatus(t("sftp.downloading", { name: entry.name }));
    this.startProgress("download");
    try {
      const bytes = await sftpDownload(this.activeDeviceId, remote, local);
      this.completeProgress();
      this.setStatus(t("sftp.downloaded", { name: entry.name, size: formatSize(bytes) }));
      this.options.onSuccess?.(t("sftp.downloadedToast", { name: entry.name }));
    } catch (err) {
      this.handleTransferError(err as AppError);
    } finally {
      this.setBusy(false);
    }
  }

  private async handleUpload(): Promise<void> {
    if (this.activeDeviceId === null) return;
    const local = await pickUploadOpenPath();
    if (local === null) return; // cancelled
    const name = await basename(local);
    const remote = joinRemote(this.cwd, name);
    this.setBusy(true);
    this.setStatus(t("sftp.uploading", { name }));
    this.startProgress("upload");
    try {
      await sftpUpload(this.activeDeviceId, local, remote);
      this.completeProgress();
      this.options.onSuccess?.(t("sftp.uploadedToast", { name }));
      await this.loadDir(this.cwd); // reflect the new file
    } catch (err) {
      this.handleTransferError(err as AppError);
      this.setBusy(false);
    }
  }

  /**
   * Shared error handling for a transfer: a user cancellation
   * (`code === "Cancelled"`) is quiet — just a status line, no error toast —
   * while a real failure surfaces through `onError`. Either way the progress
   * bar is hidden.
   */
  private handleTransferError(error: AppError): void {
    this.hideProgress();
    if (error.code === "Cancelled") {
      this.setStatus(t("sftp.transferCancelled"));
    } else {
      this.setStatus("");
      this.options.onError?.(error);
    }
  }

  private async handleCancelTransfer(): Promise<void> {
    if (this.activeDeviceId === null) return;
    this.setStatus(t("sftp.cancelling"));
    try {
      await sftpCancelTransfer(this.activeDeviceId);
    } catch (err) {
      this.options.onError?.(err as AppError);
    }
  }

  private async handleMkdir(): Promise<void> {
    if (this.activeDeviceId === null) return;
    const name = await prompt(t("sftp.mkdir.title"), t("sftp.mkdir.placeholder"));
    if (name === null || name.trim() === "") return;
    try {
      await sftpMkdir(this.activeDeviceId, joinRemote(this.cwd, name.trim()));
      await this.loadDir(this.cwd);
    } catch (err) {
      this.options.onError?.(err as AppError);
    }
  }

  private async handleRename(entry: SftpEntry): Promise<void> {
    if (this.activeDeviceId === null) return;
    this.clearHover();
    const next = await prompt(t("sftp.rename.title"), t("sftp.rename.placeholder"), entry.name);
    if (next === null || next.trim() === "" || next.trim() === entry.name) return;
    try {
      await sftpRename(
        this.activeDeviceId,
        joinRemote(this.cwd, entry.name),
        joinRemote(this.cwd, next.trim()),
      );
      await this.loadDir(this.cwd);
    } catch (err) {
      this.options.onError?.(err as AppError);
    }
  }

  private async handleDelete(entry: SftpEntry): Promise<void> {
    if (this.activeDeviceId === null) return;
    this.clearHover();
    const isDir = entry.kind === "dir";
    const confirmed = await confirm(
      isDir
        ? t("sftp.delete.messageDir", { name: entry.name })
        : t("sftp.delete.message", { name: entry.name }),
      { title: t("sftp.delete.title"), confirmLabel: t("common.delete"), danger: true },
    );
    if (!confirmed) return;
    try {
      await sftpRemove(this.activeDeviceId, joinRemote(this.cwd, entry.name), isDir);
      await this.loadDir(this.cwd);
    } catch (err) {
      this.options.onError?.(err as AppError);
    }
  }

  /* ----- device picker + disconnected state ------------------------------ */

  /** Rebuild the device `<select>` options from the current browsable devices,
   * preserving the current selection when it still exists. */
  private refreshDeviceSelect(): void {
    const select = this.deviceSelectEl;
    if (!select) return;
    const devices = browsableDevices(this.devices);
    select.replaceChildren();

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = t("sftp.selectDevice");
    select.appendChild(placeholder);

    for (const device of devices) {
      const opt = document.createElement("option");
      opt.value = device.id;
      opt.textContent = device.name;
      select.appendChild(opt);
    }
    this.syncDeviceSelect();
  }

  /** Point the picker at the connected/selected device (falls back to the
   * placeholder). */
  private syncDeviceSelect(): void {
    if (this.deviceSelectEl) {
      this.deviceSelectEl.value = this.activeDeviceId ?? this.selectedDeviceId ?? "";
    }
  }

  /** Render the entry area for a not-connected panel: a Connect/Reconnect button
   * when a device is selected, or a prompt to pick one otherwise. */
  private renderDisconnectedState(): void {
    if (!this.listEl) return;
    this.listEl.replaceChildren();
    this.syncPathInput();

    const wrap = document.createElement("div");
    wrap.className = "sftp-disconnected";

    const msg = document.createElement("p");
    msg.className = "sftp-empty";
    msg.textContent = this.idleDisconnected
      ? t("sftp.idleDisconnected")
      : this.selectedDeviceId
        ? t("sftp.notConnected")
        : t("sftp.pickDevice");
    wrap.appendChild(msg);
    this.listEl.appendChild(wrap);
  }

  /* ----- entry rendering -------------------------------------------------- */

  private renderEntries(entries: SftpEntry[]): void {
    if (!this.listEl) return;
    this.listEl.replaceChildren();

    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "sftp-empty";
      empty.textContent = t("sftp.emptyDir");
      this.listEl.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      this.listEl.appendChild(this.renderEntryRow(entry));
    }
  }

  private renderEntryRow(entry: SftpEntry): HTMLElement {
    const isDir = entry.kind === "dir";
    const row = document.createElement("div");
    row.className = `sftp-entry is-${entry.kind}`;
    row.setAttribute("role", "listitem");
    // Hover is tracked in JS (not CSS `:hover`): a native OS dialog opens without
    // firing `mouseleave`, which would leave the row's action buttons stuck on.
    row.addEventListener("mouseenter", () => row.classList.add("hovering"));
    row.addEventListener("mouseleave", () => row.classList.remove("hovering"));

    const icon = document.createElement("span");
    icon.className = "sftp-entry-icon";
    icon.textContent = isDir ? "📁" : entry.kind === "symlink" ? "🔗" : "📄";

    const name = document.createElement("button");
    name.type = "button";
    name.className = "sftp-entry-name";
    name.textContent = entry.name;
    name.title = isDir ? t("sftp.entry.openFolder") : t("sftp.entry.downloadFile");
    // A directory descends; a file/symlink downloads.
    name.addEventListener("click", () => {
      if (this.busy) return;
      if (isDir) void this.goTo(joinRemote(this.cwd, entry.name));
      else void this.handleDownload(entry);
    });

    const meta = document.createElement("span");
    meta.className = "sftp-entry-meta";
    const size = isDir ? "" : formatSize(entry.size);
    const time = formatMtime(entry.modified);
    meta.textContent = [size, time].filter(Boolean).join("  ·  ");

    const actions = document.createElement("span");
    actions.className = "sftp-entry-actions";
    if (!isDir) {
      actions.appendChild(
        this.iconButton(downloadIcon, t("sftp.entry.download"), () => void this.handleDownload(entry)),
      );
    }
    actions.appendChild(
      this.iconButton(pencilIcon, t("sftp.entry.rename"), () => void this.handleRename(entry)),
    );
    actions.appendChild(
      this.iconButton(trashIcon, t("sftp.entry.delete"), () => void this.handleDelete(entry), true),
    );

    row.append(icon, name, meta, actions);
    return row;
  }

  private iconButton(
    html: string,
    label: string,
    onClick: () => void,
    danger = false,
  ): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `btn btn-icon btn-small${danger ? " btn-danger" : ""}`;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.innerHTML = html;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!this.busy) onClick();
    });
    return btn;
  }

  /* ----- splitter (resize) ------------------------------------------------ */

  private wireSplitter(): void {
    const splitter = this.splitter;
    if (!splitter || this.splitterWired) return;
    this.splitterWired = true;
    splitter.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.drag = { startX: e.clientX, startWidth: this.width };
      splitter.classList.add("dragging");
      document.body.classList.add("sftp-resizing");
      window.addEventListener("mousemove", this.onDragMove);
      window.addEventListener("mouseup", this.onDragEnd);
    });
  }

  /** Dragging left (toward the grid) widens the right-docked panel. Clamped to
   * `[MIN_PANEL_WIDTH, workspace − MIN_GRID_WIDTH]`. */
  private onDragMove = (e: MouseEvent): void => {
    if (!this.drag || !this.panel) return;
    const rowWidth =
      this.panel.parentElement?.getBoundingClientRect().width ?? this.width + MIN_GRID_WIDTH;
    const max = Math.max(MIN_PANEL_WIDTH, rowWidth - MIN_GRID_WIDTH);
    const next = this.drag.startWidth + (this.drag.startX - e.clientX);
    this.width = Math.min(max, Math.max(MIN_PANEL_WIDTH, next));
    this.panel.style.width = `${this.width}px`;
    this.options.onLayoutChange?.();
  };

  private onDragEnd = (): void => {
    this.drag = null;
    this.splitter?.classList.remove("dragging");
    document.body.classList.remove("sftp-resizing");
    window.removeEventListener("mousemove", this.onDragMove);
    window.removeEventListener("mouseup", this.onDragEnd);
    this.options.onLayoutChange?.();
    this.persist(); // save the new width once, at drag end
  };

  /* ----- small view helpers ---------------------------------------------- */

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  /** Reflect connection state onto the indicator dot and the connect/disconnect
   * toggle (red + Disconnect when connected, green + Connect when not). */
  private updateConnDot(): void {
    const connected = this.activeDeviceId !== null;
    this.connDotEl?.classList.toggle("connected", connected);
    const btn = this.connToggleEl;
    if (btn) {
      btn.classList.toggle("is-connected", connected);
      btn.classList.toggle("is-disconnected", !connected);
      // Disconnected with no device chosen yet → nothing to connect.
      btn.disabled = !connected && !this.selectedDeviceId;
      const label = connected ? t("sftp.disconnect") : t("sftp.connect");
      btn.title = label;
      btn.setAttribute("aria-label", label);
    }
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.panel
      ?.querySelectorAll<HTMLButtonElement>(".sftp-toolbar .btn")
      .forEach((b) => {
        b.disabled = busy;
      });
    if (this.pathEl) this.pathEl.readOnly = busy;
    if (this.deviceSelectEl) this.deviceSelectEl.disabled = busy;
    if (!busy) this.updateNavButtons();
  }

  /** Enable/disable Back and Forward per the history cursor (idle state only). */
  private updateNavButtons(): void {
    const back = this.panel?.querySelector<HTMLButtonElement>('[data-action="back"]');
    const forward = this.panel?.querySelector<HTMLButtonElement>('[data-action="forward"]');
    if (back) back.disabled = this.historyIndex <= 0;
    if (forward) forward.disabled = this.historyIndex >= this.history.length - 1;
  }

  /* ----- transfer progress ----------------------------------------------- */

  /** Show the progress row at 0 % for a starting transfer. */
  private startProgress(direction: "download" | "upload"): void {
    if (!this.progressEl) return;
    this.clearHideTimer();
    this.progressEl.classList.remove("done");
    this.progressEl.classList.add("active");
    this.setProgressIcon(direction);
    this.setFill(0);
    if (this.progressPctEl) this.progressPctEl.textContent = "0%";
  }

  /** Update the bar from a throttled `sftp_progress` event for the active device. */
  private onProgress(e: SftpProgressEvent): void {
    if (e.deviceId !== this.activeDeviceId || !this.progressEl) return;
    this.clearHideTimer();
    this.progressEl.classList.remove("done");
    this.progressEl.classList.add("active");
    this.setProgressIcon(e.direction);
    const pct =
      e.total > 0 ? Math.min(100, Math.round((e.transferred / e.total) * 100)) : 0;
    this.setFill(pct);
    if (this.progressPctEl) {
      this.progressPctEl.textContent =
        e.total > 0 ? `${pct}%` : formatSize(e.transferred);
    }
  }

  /** Collapse the bar to a checkmark on completion, then auto-hide after ~2.5 s. */
  private completeProgress(): void {
    if (!this.progressEl) return;
    this.clearHideTimer();
    this.setFill(100);
    this.progressEl.classList.add("active", "done");
    if (this.progressIconEl) this.progressIconEl.textContent = "✓";
    if (this.progressPctEl) this.progressPctEl.textContent = t("sftp.progress.done");
    this.progressHideTimer = setTimeout(() => this.hideProgress(), 2500);
  }

  private hideProgress(): void {
    this.clearHideTimer();
    this.progressEl?.classList.remove("active", "done");
  }

  private clearHideTimer(): void {
    if (this.progressHideTimer !== null) {
      clearTimeout(this.progressHideTimer);
      this.progressHideTimer = null;
    }
  }

  private setFill(pct: number): void {
    if (this.progressFillEl) this.progressFillEl.style.width = `${pct}%`;
  }

  private setProgressIcon(direction: "download" | "upload"): void {
    if (this.progressIconEl) {
      this.progressIconEl.innerHTML =
        direction === "upload" ? uploadIcon : downloadIcon;
    }
  }
}

/** Constructs and initializes the Files (SFTP) panel. */
export function initSftpPanel(options: SftpPanelOptions = {}): SftpPanel {
  const panel = new SftpPanel(options);
  void panel.init();
  return panel;
}
