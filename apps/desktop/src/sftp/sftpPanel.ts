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
  sftpDownloadDir,
  sftpUploadDir,
  sftpLocalExists,
  sftpExists,
  sftpCancelTransfer,
  sftpChmod,
  sftpBookmarks,
  sftpBookmarkAdd,
  sftpBookmarkRemove,
  onSftpProgress,
  type AppError,
  type ConflictPolicy,
  type Device,
  type SftpEntry,
  type SftpPanelState,
  type SshDevice,
} from "../ipc";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  pickDownloadSavePath,
  pickDownloadDirPath,
  pickUploadOpenPath,
  pickUploadDirPath,
} from "../ui/fileDialog";
import { confirm, prompt, chooseConflict, choosePermissions } from "../ui/confirm";
import {
  trashIcon,
  pencilIcon,
  arrowUpIcon,
  copyIcon,
  arrowLeftIcon,
  arrowRightIcon,
  reloadIcon,
  uploadIcon,
  uploadFolderIcon,
  downloadIcon,
  folderPlusIcon,
  chevronLeftIcon,
  chevronRightIcon,
  disconnectIcon,
  lockIcon,
  bookmarkIcon,
  bookmarkFilledIcon,
} from "../ui/icons";
import { joinRemote, parentOf, formatSize, formatMtime, formatMode } from "./sftpFormat";
import { TransferQueue, type TransferItem } from "./transferQueue";
import { basename, join } from "@tauri-apps/api/path";
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
  private filterEl: HTMLInputElement | null = null;
  private bookmarksEl: HTMLElement | null = null;
  private bulkBarEl: HTMLElement | null = null;
  private selectAllEl: HTMLInputElement | null = null;
  private selCountEl: HTMLElement | null = null;
  private pasteBtnEl: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;
  /** Container for the background transfer-queue list (rendered from `queue`). */
  private queueEl: HTMLElement | null = null;

  /** The background transfer queue: up/downloads run here while browsing stays
   * live. Rebuilt on every panel rebuild so its hooks close over fresh DOM refs. */
  private queue!: TransferQueue;
  /** Per-item auto-remove timers for completed transfers (id → timer). */
  private queueHideTimers = new Map<number, ReturnType<typeof setTimeout>>();

  /** `sftp_progress` event subscription (live while the panel exists). */
  private unlistenProgress: UnlistenFn | null = null;
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
  /** The full listing from the backend, before the filter/sort view is applied. */
  private allEntries: SftpEntry[] = [];
  /** The entries currently rendered (filtered + sorted view of `allEntries`) —
   * mirrors DOM order for select-all + shift-range + kind lookup. */
  private currentEntries: SftpEntry[] = [];
  /** Active sort column + direction (folders always stay grouped on top). */
  private sortKey: "name" | "size" | "modified" = "name";
  private sortDir: "asc" | "desc" = "asc";
  /** Live name filter for the current directory (cleared on navigation). */
  private filterText = "";
  /** The connected device's saved bookmark paths (loaded on connect). */
  private bookmarks: string[] = [];
  /** Names (cwd-relative) selected via the checkboxes; cleared on navigation. */
  private selected = new Set<string>();
  /** Row index of the last checkbox toggled, for shift-click range selection. */
  private lastClickedIndex = -1;
  /**
   * The pending Move ("cut") set: the source device + directory and the entry
   * names to move on the next Paste. Survives navigation (cut here → open a
   * folder → paste), but is tied to one connection.
   */
  private moveClipboard: { deviceId: string; dir: string; names: string[] } | null = null;
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
    this.queue = new TransferQueue({
      cancelActive: (deviceId) => void this.cancelActiveTransfer(deviceId),
      onChange: () => this.renderQueue(),
      onProgress: (item) => this.updateQueueRowProgress(item),
      onComplete: (item, ctx) => this.onTransferComplete(item, ctx),
    });
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
    this.clearQueueHideTimers();
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
            <button type="button" class="btn btn-icon" data-action="upload-dir" title="${t("sftp.nav.uploadDir")}" aria-label="${t("sftp.nav.uploadDir")}">${uploadFolderIcon}</button>
            <button type="button" class="btn btn-icon" data-action="mkdir" title="${t("sftp.nav.mkdir")}" aria-label="${t("sftp.nav.mkdir")}">${folderPlusIcon}</button>
            <button type="button" class="btn btn-icon sftp-bookmark-toggle" data-action="bookmark-toggle" title="${t("sftp.bookmark.add")}" aria-label="${t("sftp.bookmark.add")}">${bookmarkIcon}</button>
          </div>
        </div>
        <div class="sftp-bookmarks" role="list" hidden></div>
        <div class="sftp-listhead">
          <input type="text" class="sftp-filter" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="${t("sftp.filter.aria")}" placeholder="${t("sftp.filter.placeholder")}" />
          <div class="sftp-sortbtns" role="group" aria-label="${t("sftp.sort.aria")}">
            <button type="button" class="btn btn-small" data-action="sort" data-sort="name">${t("sftp.sort.name")}</button>
            <button type="button" class="btn btn-small" data-action="sort" data-sort="size">${t("sftp.sort.size")}</button>
            <button type="button" class="btn btn-small" data-action="sort" data-sort="modified">${t("sftp.sort.modified")}</button>
          </div>
        </div>
        <div class="sftp-bulkbar" hidden>
          <label class="sftp-selectall">
            <input type="checkbox" data-action="select-all" aria-label="${t("sftp.selectAll")}" />
            <span class="sftp-sel-count"></span>
          </label>
          <div class="sftp-bulk-actions">
            <button type="button" class="btn btn-small" data-action="bulk-download">${t("sftp.bulk.download")}</button>
            <button type="button" class="btn btn-small" data-action="bulk-cut">${t("sftp.bulk.move")}</button>
            <button type="button" class="btn btn-small sftp-bulk-paste" data-action="bulk-paste" hidden>${t("sftp.bulk.paste")}</button>
            <button type="button" class="btn btn-small btn-danger" data-action="bulk-delete">${t("common.delete")}</button>
            <button type="button" class="btn btn-small" data-action="bulk-clear">${t("sftp.bulk.clear")}</button>
          </div>
        </div>
        <div class="sftp-entries" role="list"></div>
        <div class="sftp-queue" role="status" aria-live="polite" hidden></div>
        <div class="sftp-status" aria-live="polite"></div>
      </div>
    `;

    this.deviceSelectEl = panel.querySelector(".sftp-device-select");
    this.connDotEl = panel.querySelector(".sftp-conn-dot");
    this.connToggleEl = panel.querySelector(".sftp-conn-toggle");
    this.pathEl = panel.querySelector(".sftp-path");
    this.listEl = panel.querySelector(".sftp-entries");
    this.filterEl = panel.querySelector(".sftp-filter");
    this.bookmarksEl = panel.querySelector(".sftp-bookmarks");
    this.bulkBarEl = panel.querySelector(".sftp-bulkbar");
    this.selectAllEl = panel.querySelector('[data-action="select-all"]');
    this.selCountEl = panel.querySelector(".sftp-sel-count");
    this.pasteBtnEl = panel.querySelector(".sftp-bulk-paste");
    this.statusEl = panel.querySelector(".sftp-status");
    this.queueEl = panel.querySelector(".sftp-queue");
    this.renderQueue();

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

    // Live directory filter — reorders the current listing without a round trip.
    this.filterEl?.addEventListener("input", () => {
      this.filterText = this.filterEl?.value ?? "";
      // A changed filter changes the visible set, so drop the stale selection.
      this.selected.clear();
      this.lastClickedIndex = -1;
      this.applyView();
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
        case "upload-dir":
          if (!this.busy) void this.handleUploadFolder();
          break;
        case "mkdir":
          if (!this.busy) void this.handleMkdir();
          break;
        case "sort": {
          const key = target.closest<HTMLElement>("[data-sort]")?.dataset.sort;
          if (key === "name" || key === "size" || key === "modified") this.setSort(key);
          break;
        }
        case "bookmark-toggle":
          if (!this.busy) void this.handleBookmarkToggle();
          break;
        case "bookmark-go": {
          const path = target.closest<HTMLElement>("[data-path]")?.dataset.path;
          if (path && !this.busy) void this.goTo(path);
          break;
        }
        case "bookmark-del": {
          const path = target.closest<HTMLElement>("[data-path]")?.dataset.path;
          if (path) void this.handleBookmarkRemove(path);
          break;
        }
        case "tx-cancel": {
          const id = Number(target.closest<HTMLElement>("[data-tx-id]")?.dataset.txId);
          if (Number.isFinite(id)) this.queue.cancel(id);
          break;
        }
        case "tx-dismiss": {
          const id = Number(target.closest<HTMLElement>("[data-tx-id]")?.dataset.txId);
          if (Number.isFinite(id)) {
            const timer = this.queueHideTimers.get(id);
            if (timer) clearTimeout(timer);
            this.queueHideTimers.delete(id);
            this.queue.remove(id);
          }
          break;
        }
        case "tx-clear":
          this.clearQueueHideTimers();
          this.queue.clearFinished();
          break;
        case "select-all":
          this.toggleSelectAll();
          break;
        case "bulk-download":
          if (!this.busy) void this.handleBulkDownload();
          break;
        case "bulk-cut":
          this.handleBulkCut();
          break;
        case "bulk-paste":
          if (!this.busy) void this.handleBulkPaste();
          break;
        case "bulk-delete":
          if (!this.busy) void this.handleBulkDelete();
          break;
        case "bulk-clear":
          this.clearSelection();
          break;
      }
    });

    this.wireSplitter();

    // Live transfer progress (throttled events from the backend) → active item.
    void onSftpProgress((e) => this.queue.applyProgress(e.deviceId, e.transferred, e.total)).then(
      (un) => {
        this.unlistenProgress = un;
      },
    );
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
      await this.loadBookmarks(deviceId);
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
    this.moveClipboard = null; // a pending move is tied to this connection
    this.bookmarks = []; // bookmarks are loaded per active device
    this.renderBookmarks();
    this.updateBookmarkButton();
    if (deviceId) {
      // Cancel + drop any transfers for this device — the connection is going
      // away, so nothing more can run against it.
      this.queue.cancelDevice(deviceId);
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
    // Re-listing the same directory (Refresh, or an auto-refresh after a
    // transfer) keeps any live filter; navigating to a different directory
    // starts fresh.
    const sameDir = path === this.cwd;
    // A new listing invalidates the selection (names are directory-relative).
    this.selected.clear();
    this.lastClickedIndex = -1;
    this.setBusy(true);
    try {
      const entries = await sftpList(this.activeDeviceId, path);
      this.cwd = path;
      this.allEntries = entries;
      if (!sameDir) {
        this.filterText = "";
        if (this.filterEl) this.filterEl.value = "";
      }
      this.syncPathInput();
      this.applyView(); // renders + sets the count status
      this.updateBookmarkButton();
    } catch (err) {
      this.options.onError?.(err as AppError);
    } finally {
      this.setBusy(false); // also reconciles Back/Forward enabled state
    }
  }

  /** Compute the filtered + sorted view of `allEntries` and render it (folders
   * stay grouped on top regardless of the sort key/direction). Also refreshes
   * the sort-header indicators and the visible-count status. */
  private applyView(): void {
    const needle = this.filterText.trim().toLowerCase();
    const filtered = needle
      ? this.allEntries.filter((e) => e.name.toLowerCase().includes(needle))
      : this.allEntries.slice();
    filtered.sort((a, b) => this.compareEntries(a, b));
    this.renderEntries(filtered);
    this.updateSortHeaders();
    this.setStatus(tp("sftp.count", filtered.length));
  }

  /** Ordering: folders before files always; then by the active key/direction,
   * with a case-insensitive name tiebreak. */
  private compareEntries(a: SftpEntry, b: SftpEntry): number {
    const aDir = a.kind === "dir";
    const bDir = b.kind === "dir";
    if (aDir !== bDir) return aDir ? -1 : 1;
    let cmp: number;
    if (this.sortKey === "size") cmp = a.size - b.size;
    else if (this.sortKey === "modified") cmp = (a.modified ?? 0) - (b.modified ?? 0);
    else cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    if (cmp === 0 && this.sortKey !== "name") {
      cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    }
    return this.sortDir === "asc" ? cmp : -cmp;
  }

  /** Apply a sort column: clicking the active column flips direction, a new
   * column selects it ascending. */
  private setSort(key: "name" | "size" | "modified"): void {
    if (this.sortKey === key) {
      this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
    } else {
      this.sortKey = key;
      this.sortDir = "asc";
    }
    // Reordering invalidates the shift-click anchor (it's a positional index).
    this.lastClickedIndex = -1;
    this.applyView();
  }

  /** Reflect the active sort key + direction on the header buttons (an arrow on
   * the active one; `aria-sort` for assistive tech). */
  private updateSortHeaders(): void {
    this.panel?.querySelectorAll<HTMLButtonElement>('[data-action="sort"]').forEach((btn) => {
      const active = btn.dataset.sort === this.sortKey;
      const arrow = active ? (this.sortDir === "asc" ? " ▲" : " ▼") : "";
      const label = t(`sftp.sort.${btn.dataset.sort as "name" | "size" | "modified"}`);
      btn.textContent = label + arrow;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-sort", active ? (this.sortDir === "asc" ? "ascending" : "descending") : "none");
    });
  }

  /* ----- bookmarks -------------------------------------------------------- */

  /** Load the connected device's bookmarks and render the chip row. Non-fatal:
   * a failure just leaves the bar empty (bookmarks are a convenience). */
  private async loadBookmarks(deviceId: string): Promise<void> {
    try {
      this.bookmarks = await sftpBookmarks(deviceId);
    } catch {
      this.bookmarks = [];
    }
    this.renderBookmarks();
    this.updateBookmarkButton();
  }

  /** Render the bookmark chips (hidden when none). Built with DOM APIs — the
   * paths are remote-supplied, so they go in as text, never markup. */
  private renderBookmarks(): void {
    const el = this.bookmarksEl;
    if (!el) return;
    el.replaceChildren();
    if (this.activeDeviceId === null || this.bookmarks.length === 0) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    for (const path of this.bookmarks) {
      const chip = document.createElement("span");
      chip.className = "sftp-bookmark";
      chip.setAttribute("role", "listitem");
      if (path === this.cwd) chip.classList.add("is-current");
      const go = document.createElement("button");
      go.type = "button";
      go.className = "sftp-bookmark-go";
      go.dataset.action = "bookmark-go";
      go.dataset.path = path;
      go.textContent = bookmarkLabel(path);
      go.title = path;
      const del = document.createElement("button");
      del.type = "button";
      del.className = "sftp-bookmark-del";
      del.dataset.action = "bookmark-del";
      del.dataset.path = path;
      del.title = t("sftp.bookmark.remove");
      del.setAttribute("aria-label", t("sftp.bookmark.remove"));
      del.textContent = "×";
      chip.append(go, del);
      el.appendChild(chip);
    }
  }

  /** Swap the toolbar star between add/remove per whether cwd is bookmarked. */
  private updateBookmarkButton(): void {
    const btn = this.panel?.querySelector<HTMLElement>(".sftp-bookmark-toggle");
    if (!btn) return;
    const marked = this.activeDeviceId !== null && this.bookmarks.includes(this.cwd);
    btn.innerHTML = marked ? bookmarkFilledIcon : bookmarkIcon;
    const label = marked ? t("sftp.bookmark.remove") : t("sftp.bookmark.add");
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.classList.toggle("is-marked", marked);
    // Keep the chip-row's current-directory highlight in sync.
    this.renderBookmarks();
  }

  /** Bookmark (or un-bookmark) the current directory. */
  private async handleBookmarkToggle(): Promise<void> {
    if (this.activeDeviceId === null) return;
    const deviceId = this.activeDeviceId;
    try {
      this.bookmarks = this.bookmarks.includes(this.cwd)
        ? await sftpBookmarkRemove(deviceId, this.cwd)
        : await sftpBookmarkAdd(deviceId, this.cwd);
      this.updateBookmarkButton();
    } catch (err) {
      this.options.onError?.(err as AppError);
    }
  }

  /** Remove a bookmark from its chip's × button. */
  private async handleBookmarkRemove(path: string): Promise<void> {
    if (this.activeDeviceId === null) return;
    try {
      this.bookmarks = await sftpBookmarkRemove(this.activeDeviceId, path);
      this.updateBookmarkButton();
    } catch (err) {
      this.options.onError?.(err as AppError);
    }
  }

  /* ----- permissions (chmod) --------------------------------------------- */

  /** Open the chmod dialog for an entry and apply the chosen mode. */
  private async handlePermissions(entry: SftpEntry): Promise<void> {
    if (this.activeDeviceId === null) return;
    this.clearHover();
    const next = await choosePermissions(entry.name, entry.mode ?? 0);
    if (next === null) return; // cancelled
    const deviceId = this.activeDeviceId;
    const path = joinRemote(this.cwd, entry.name);
    try {
      await sftpChmod(deviceId, path, next);
      await this.loadDir(this.cwd);
      this.options.onSuccess?.(t("sftp.perms.changed", { name: entry.name }));
    } catch (err) {
      this.options.onError?.(err as AppError);
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
    const deviceId = this.activeDeviceId;
    const remote = joinRemote(this.cwd, entry.name);
    this.queue.enqueue({
      deviceId,
      direction: "download",
      isDir: false,
      name: entry.name,
      run: () => sftpDownload(deviceId, remote, local),
      successToast: t("sftp.downloadedToast", { name: entry.name }),
    });
  }

  private async handleUpload(): Promise<void> {
    if (this.activeDeviceId === null) return;
    const local = await pickUploadOpenPath();
    if (local === null) return; // cancelled
    const deviceId = this.activeDeviceId;
    const dir = this.cwd;
    const name = await basename(local);
    const remote = joinRemote(dir, name);
    this.queue.enqueue({
      deviceId,
      direction: "upload",
      isDir: false,
      name,
      run: () => sftpUpload(deviceId, local, remote),
      successToast: t("sftp.uploadedToast", { name }),
      refreshDir: dir,
    });
  }

  /** Recursively download a folder into a chosen local directory, resolving a
   * name clash with a per-operation conflict policy. */
  private async handleDownloadFolder(entry: SftpEntry): Promise<void> {
    if (this.activeDeviceId === null) return;
    this.clearHover();
    const destParent = await pickDownloadDirPath();
    if (destParent === null) return; // cancelled
    const deviceId = this.activeDeviceId;
    const remote = joinRemote(this.cwd, entry.name);
    const target = await join(destParent, entry.name);
    const policy = await this.resolvePolicy(
      await sftpLocalExists(target),
      t("sftp.conflict.message", { name: entry.name }),
    );
    if (policy === null) return; // cancelled the conflict dialog
    this.queue.enqueue({
      deviceId,
      direction: "download",
      isDir: true,
      name: entry.name,
      run: () => sftpDownloadDir(deviceId, remote, target, policy),
      successToast: t("sftp.downloadedFolderToast", { name: entry.name }),
    });
  }

  /** Recursively upload a chosen local folder into the current directory. */
  private async handleUploadFolder(): Promise<void> {
    if (this.activeDeviceId === null) return;
    const localDir = await pickUploadDirPath();
    if (localDir === null) return; // cancelled
    const deviceId = this.activeDeviceId;
    const dir = this.cwd;
    const name = await basename(localDir);
    const target = joinRemote(dir, name);
    const policy = await this.resolvePolicy(
      await sftpExists(deviceId, target),
      t("sftp.conflict.message", { name }),
    );
    if (policy === null) return;
    this.queue.enqueue({
      deviceId,
      direction: "upload",
      isDir: true,
      name,
      run: () => sftpUploadDir(deviceId, localDir, target, policy),
      successToast: t("sftp.uploadedFolderToast", { name }),
      refreshDir: dir,
    });
  }

  /**
   * Resolve the conflict policy for a transfer: `"overwrite"` when there is no
   * clash, otherwise the user's choice from the conflict dialog (or `null` if
   * they cancel). One choice applies to the whole operation.
   */
  private async resolvePolicy(conflict: boolean, message: string): Promise<ConflictPolicy | null> {
    if (!conflict) return "overwrite";
    return chooseConflict(message);
  }

  /** First `<path>` / `<path> (2)` / … that doesn't exist locally (for the
   * per-file rename policy in a bulk download). */
  private async freshLocalName(path: string): Promise<string> {
    if (!(await sftpLocalExists(path))) return path;
    let i = 2;
    // eslint-disable-next-line no-constant-condition
    for (;;) {
      const candidate = `${path} (${i})`;
      if (!(await sftpLocalExists(candidate))) return candidate;
      i += 1;
    }
  }

  /**
   * Queue hook: an item reached a terminal state. A success surfaces its toast
   * (and re-lists the directory if an upload landed in the one on screen), then
   * auto-clears the row after a moment; a real failure surfaces through `onError`
   * and the row stays until dismissed; a user cancel is quiet.
   */
  private onTransferComplete(
    item: TransferItem,
    ctx: { successToast?: string; refreshDir?: string },
  ): void {
    if (item.state === "done") {
      if (ctx.successToast) this.options.onSuccess?.(ctx.successToast);
      // Reflect a new upload if we're still showing the directory it landed in.
      if (
        ctx.refreshDir !== undefined &&
        this.activeDeviceId === item.deviceId &&
        this.cwd === ctx.refreshDir &&
        !this.busy
      ) {
        void this.loadDir(this.cwd);
      }
      this.scheduleQueueItemHide(item.id);
    } else if (item.state === "failed" && item.error) {
      this.options.onError?.(item.error);
    }
    // "cancelled": quiet — the row stays until dismissed/cleared.
  }

  /** Queue hook: ask the backend to cancel the in-flight transfer for a device. */
  private async cancelActiveTransfer(deviceId: string): Promise<void> {
    try {
      await sftpCancelTransfer(deviceId);
    } catch (err) {
      this.options.onError?.(err as AppError);
    }
  }

  /** Auto-remove a completed transfer row after a short delay. */
  private scheduleQueueItemHide(id: number): void {
    const existing = this.queueHideTimers.get(id);
    if (existing) clearTimeout(existing);
    this.queueHideTimers.set(
      id,
      setTimeout(() => {
        this.queueHideTimers.delete(id);
        this.queue.remove(id);
      }, 3000),
    );
  }

  private clearQueueHideTimers(): void {
    for (const timer of this.queueHideTimers.values()) clearTimeout(timer);
    this.queueHideTimers.clear();
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
      await sftpRemove(this.activeDeviceId, joinRemote(this.cwd, entry.name), isDir, isDir);
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
    this.selected.clear();
    this.currentEntries = [];
    if (this.bulkBarEl) this.bulkBarEl.hidden = true;
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

  /* ----- multi-select + bulk operations ---------------------------------- */

  /** Toggle one row's checkbox; with `shift`, select the range from the last
   * toggled row (inclusive) to this one. */
  private onCheckToggle(index: number, shift: boolean): void {
    if (shift && this.lastClickedIndex >= 0) {
      const lo = Math.min(this.lastClickedIndex, index);
      const hi = Math.max(this.lastClickedIndex, index);
      for (let i = lo; i <= hi; i++) {
        const name = this.currentEntries[i]?.name;
        if (name) this.selected.add(name);
      }
    } else {
      const name = this.currentEntries[index]?.name;
      if (name) {
        if (this.selected.has(name)) this.selected.delete(name);
        else this.selected.add(name);
      }
    }
    this.lastClickedIndex = index;
    this.syncSelectionDom();
  }

  /** Select every entry when not all are selected, else clear (the header box). */
  private toggleSelectAll(): void {
    const allSelected = this.currentEntries.length > 0 && this.selected.size === this.currentEntries.length;
    this.selected.clear();
    if (!allSelected) {
      for (const entry of this.currentEntries) this.selected.add(entry.name);
    }
    // Reset the shift-range anchor so a following shift-click doesn't extend from
    // a stale row.
    this.lastClickedIndex = -1;
    this.syncSelectionDom();
  }

  private clearSelection(): void {
    this.selected.clear();
    this.lastClickedIndex = -1;
    this.syncSelectionDom();
  }

  /** Push the selection state onto the row checkboxes + the bulk bar. */
  private syncSelectionDom(): void {
    this.listEl
      ?.querySelectorAll<HTMLElement>(".sftp-entry")
      .forEach((row, i) => {
        const check = row.querySelector<HTMLInputElement>(".sftp-entry-check");
        if (check) check.checked = this.selected.has(this.currentEntries[i]?.name ?? "");
      });
    this.updateBulkBar();
  }

  /** Reflect selection count + clipboard onto the bulk bar (count, enabled
   * actions, Paste visibility). */
  private updateBulkBar(): void {
    const n = this.selected.size;
    if (this.selCountEl) {
      this.selCountEl.textContent = n > 0 ? tp("sftp.selected", n) : t("sftp.selectAll");
    }
    if (this.selectAllEl) {
      const total = this.currentEntries.length;
      this.selectAllEl.checked = total > 0 && n === total;
      this.selectAllEl.indeterminate = n > 0 && n < total;
    }
    this.bulkBarEl
      ?.querySelectorAll<HTMLButtonElement>('[data-action^="bulk-"]:not(.sftp-bulk-paste)')
      .forEach((b) => {
        b.disabled = n === 0;
      });
    // Paste shows only when a move is pending on THIS connection and we've moved
    // to a different directory than the source (pasting into the source is a no-op).
    const canPaste =
      this.moveClipboard !== null &&
      this.moveClipboard.deviceId === this.activeDeviceId &&
      this.moveClipboard.dir !== this.cwd;
    if (this.pasteBtnEl) {
      this.pasteBtnEl.hidden = !canPaste;
      this.pasteBtnEl.disabled = !canPaste;
    }
  }

  /** The selected entries, resolved against the current listing. */
  private selectedEntries(): SftpEntry[] {
    return this.currentEntries.filter((e) => this.selected.has(e.name));
  }

  /** Download every selected entry into one chosen local folder — files
   * directly, folders recursively — under a single conflict policy. Sequential,
   * with the shared progress bar per file. */
  private async handleBulkDownload(): Promise<void> {
    if (this.activeDeviceId === null) return;
    const entries = this.selectedEntries();
    if (entries.length === 0) return;
    this.clearHover();
    const dest = await pickDownloadDirPath();
    if (dest === null) return; // cancelled
    const deviceId = this.activeDeviceId;
    const srcDir = this.cwd;

    // Resolve each target and detect a conflict up front, so the policy is asked
    // once for the whole batch.
    const targets: { entry: SftpEntry; target: string }[] = [];
    let conflict = false;
    for (const entry of entries) {
      const target = await join(dest, entry.name);
      targets.push({ entry, target });
      if (!conflict && (await sftpLocalExists(target))) conflict = true;
    }
    const message =
      entries.length === 1
        ? t("sftp.conflict.message", { name: entries[0]?.name ?? "" })
        : t("sftp.conflict.messageMany");
    const policy = await this.resolvePolicy(conflict, message);
    if (policy === null) return;

    // Enqueue each selection as its own background item; they drain one at a
    // time while browsing stays live. Skip/rename are resolved at run time per
    // file. Bulk items are quiet (no per-item toast) — the queue list is the
    // feedback; a single explicit download still toasts.
    for (const { entry, target } of targets) {
      const remote = joinRemote(srcDir, entry.name);
      if (entry.kind === "dir") {
        this.queue.enqueue({
          deviceId,
          direction: "download",
          isDir: true,
          name: entry.name,
          run: () => sftpDownloadDir(deviceId, remote, target, policy),
        });
      } else {
        this.queue.enqueue({
          deviceId,
          direction: "download",
          isDir: false,
          name: entry.name,
          run: async () => {
            if (policy === "skip" && (await sftpLocalExists(target))) return;
            const local = policy === "rename" ? await this.freshLocalName(target) : target;
            await sftpDownload(deviceId, remote, local);
          },
        });
      }
    }
    this.clearSelection();
  }

  /** "Cut": record the selection for a later Paste, then clear it. */
  private handleBulkCut(): void {
    if (this.activeDeviceId === null || this.selected.size === 0) return;
    this.moveClipboard = {
      deviceId: this.activeDeviceId,
      dir: this.cwd,
      names: [...this.selected],
    };
    this.setStatus(tp("sftp.cutNotice", this.moveClipboard.names.length));
    this.clearSelection(); // also refreshes the bar (Paste now shown after navigating)
  }

  /** "Paste": move each cut entry into the current directory (server-side
   * rename). Same-connection only; conflicts surface per item. */
  private async handleBulkPaste(): Promise<void> {
    const clip = this.moveClipboard;
    if (this.activeDeviceId === null || clip === null || clip.deviceId !== this.activeDeviceId) {
      return;
    }
    if (clip.dir === this.cwd) {
      this.moveClipboard = null;
      this.updateBulkBar();
      return;
    }
    const deviceId = this.activeDeviceId;
    const dir = this.cwd;
    // The destination listing is the current directory, so name collisions can be
    // checked without an extra round trip (avoids relying on undefined server
    // overwrite-on-rename behavior — proper conflict resolution comes with #3).
    const existing = new Set(this.currentEntries.map((e) => e.name));
    this.setBusy(true);
    let done = 0;
    let firstError: AppError | null = null;
    try {
      for (const name of clip.names) {
        const src = joinRemote(clip.dir, name);
        // Reject moving a folder into itself or a descendant of itself.
        if (dir === src || dir.startsWith(`${src}/`)) {
          firstError ??= validationError(t("sftp.move.intoSelf"));
          continue;
        }
        if (existing.has(name)) {
          firstError ??= validationError(t("sftp.move.exists"));
          continue;
        }
        try {
          await sftpRename(deviceId, src, joinRemote(dir, name));
          done += 1;
        } catch (err) {
          firstError ??= err as AppError;
        }
      }
    } finally {
      this.moveClipboard = null;
      await this.loadDir(dir); // reflect the moved entries; also setBusy(false)
      this.finishBulk(tp("sftp.moved", done), done, clip.names.length, firstError);
    }
  }

  /** Delete every selected entry (folders recursively) after one confirmation. */
  private async handleBulkDelete(): Promise<void> {
    if (this.activeDeviceId === null || this.selected.size === 0) return;
    const entries = this.selectedEntries();
    const confirmed = await confirm(tp("sftp.deleteConfirm", entries.length), {
      title: t("sftp.delete.title"),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!confirmed) return;
    this.clearHover();
    // Snapshot the device + directory and hold `busy` for the whole loop: the
    // path is rebuilt each iteration, so without this a mid-loop navigation
    // would delete same-named entries in a different directory.
    const deviceId = this.activeDeviceId;
    const dir = this.cwd;
    this.setBusy(true);
    let done = 0;
    let firstError: AppError | null = null;
    for (const entry of entries) {
      const isDir = entry.kind === "dir";
      try {
        await sftpRemove(deviceId, joinRemote(dir, entry.name), isDir, isDir);
        done += 1;
      } catch (err) {
        firstError ??= err as AppError;
      }
    }
    await this.loadDir(dir); // re-lists + clears `busy`
    this.finishBulk(tp("sftp.deleted", done), done, entries.length, firstError);
  }

  /** Shared bulk-op epilogue: a success status/toast, or a partial-failure
   * status plus the first error surfaced through `onError`. */
  private finishBulk(
    successMsg: string,
    done: number,
    total: number,
    firstError: AppError | null,
  ): void {
    if (firstError && done < total) {
      this.setStatus(t("sftp.bulk.partial"));
      this.options.onError?.(firstError);
    } else if (done > 0) {
      this.setStatus(successMsg);
      this.options.onSuccess?.(successMsg);
    }
  }

  /* ----- entry rendering -------------------------------------------------- */

  private renderEntries(entries: SftpEntry[]): void {
    if (!this.listEl) return;
    this.currentEntries = entries;
    this.listEl.replaceChildren();
    if (this.bulkBarEl) this.bulkBarEl.hidden = false;

    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "sftp-empty";
      empty.textContent = t("sftp.emptyDir");
      this.listEl.appendChild(empty);
      this.updateBulkBar();
      return;
    }

    entries.forEach((entry, index) => {
      this.listEl?.appendChild(this.renderEntryRow(entry, index));
    });
    this.updateBulkBar();
  }

  private renderEntryRow(entry: SftpEntry, index: number): HTMLElement {
    const isDir = entry.kind === "dir";
    const row = document.createElement("div");
    row.className = `sftp-entry is-${entry.kind}`;
    row.setAttribute("role", "listitem");
    // Hover is tracked in JS (not CSS `:hover`): a native OS dialog opens without
    // firing `mouseleave`, which would leave the row's action buttons stuck on.
    row.addEventListener("mouseenter", () => row.classList.add("hovering"));
    row.addEventListener("mouseleave", () => row.classList.remove("hovering"));

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "sftp-entry-check";
    check.checked = this.selected.has(entry.name);
    check.setAttribute("aria-label", entry.name);
    // Shift-click selects the range from the last-toggled row (file-manager
    // convention); a plain click toggles just this entry.
    check.addEventListener("click", (e) => {
      this.onCheckToggle(index, (e as MouseEvent).shiftKey);
    });

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
    const perms = formatMode(entry.mode);
    meta.textContent = [perms, size, time].filter(Boolean).join("  ·  ");

    const actions = document.createElement("span");
    actions.className = "sftp-entry-actions";
    // Both files and folders can be downloaded (a folder recurses).
    actions.appendChild(
      this.iconButton(downloadIcon, t("sftp.entry.download"), () => {
        if (isDir) void this.handleDownloadFolder(entry);
        else void this.handleDownload(entry);
      }),
    );
    actions.appendChild(
      this.iconButton(pencilIcon, t("sftp.entry.rename"), () => void this.handleRename(entry)),
    );
    // chmod only for real files/dirs that report a mode: SETSTAT follows a
    // symlink to its target (there is no LSETSTAT in SFTP v3), so offering it on
    // a symlink row would silently rewrite the target's permissions; and a
    // server that omits mode can't be chmod'd meaningfully.
    if (entry.kind !== "symlink" && entry.mode !== undefined) {
      actions.appendChild(
        this.iconButton(lockIcon, t("sftp.entry.permissions"), () =>
          void this.handlePermissions(entry),
        ),
      );
    }
    actions.appendChild(
      this.iconButton(trashIcon, t("sftp.entry.delete"), () => void this.handleDelete(entry), true),
    );

    row.append(check, icon, name, meta, actions);
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

  /* ----- transfer queue rendering ---------------------------------------- */

  /** Rebuild the background transfer-queue list from `queue` state (hidden when
   * empty). Called on every queue change and after a panel rebuild. */
  private renderQueue(): void {
    const el = this.queueEl;
    if (!el) return;
    const items = this.queue.items();
    el.replaceChildren();
    if (items.length === 0) {
      el.hidden = true;
      return;
    }
    el.hidden = false;

    const head = document.createElement("div");
    head.className = "sftp-queue-head";
    const title = document.createElement("span");
    title.className = "sftp-queue-title";
    title.textContent = t("sftp.queue.title");
    head.appendChild(title);
    if (items.some((i) => i.state === "done" || i.state === "failed" || i.state === "cancelled")) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "btn btn-small";
      clear.dataset.action = "tx-clear";
      clear.textContent = t("sftp.queue.clear");
      head.appendChild(clear);
    }
    el.appendChild(head);

    const list = document.createElement("div");
    list.className = "sftp-queue-list";
    for (const item of items) list.appendChild(this.renderQueueRow(item));
    el.appendChild(list);
  }

  /** Update just the active row's bar + percentage in place, from a progress
   * tick. Avoids rebuilding the whole list (and re-announcing the aria-live
   * region, and re-creating the cancel button mid-click) ~20×/s. Falls back to a
   * full render if the row isn't present yet. */
  private updateQueueRowProgress(item: TransferItem): void {
    const row = this.queueEl?.querySelector<HTMLElement>(
      `.sftp-queue-item[data-tx-id="${item.id}"]`,
    );
    const fill = row?.querySelector<HTMLElement>(".sftp-queue-fill");
    const pctEl = row?.querySelector<HTMLElement>(".sftp-queue-pct");
    if (!fill || !pctEl) {
      this.renderQueue();
      return;
    }
    const pct =
      item.total > 0 ? Math.min(100, Math.round((item.transferred / item.total) * 100)) : 0;
    fill.style.width = `${pct}%`;
    pctEl.textContent = item.total > 0 ? `${pct}%` : formatSize(item.transferred);
  }

  /** One transfer row. Built with DOM APIs (not innerHTML) so the remote-supplied
   * name is inserted as text, never markup. */
  private renderQueueRow(item: TransferItem): HTMLElement {
    const row = document.createElement("div");
    row.className = `sftp-queue-item is-${item.state}`;
    row.dataset.txId = String(item.id);

    const icon = document.createElement("span");
    icon.className = "sftp-queue-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = item.direction === "upload" ? uploadIcon : downloadIcon;

    const name = document.createElement("span");
    name.className = "sftp-queue-name";
    name.textContent = item.name;
    name.title = item.name;

    const detail = document.createElement("span");
    detail.className = "sftp-queue-detail";
    let cancelAction: "tx-cancel" | "tx-dismiss" | null = null;
    switch (item.state) {
      case "active": {
        const pct =
          item.total > 0 ? Math.min(100, Math.round((item.transferred / item.total) * 100)) : 0;
        const track = document.createElement("span");
        track.className = "sftp-queue-track";
        const fill = document.createElement("span");
        fill.className = "sftp-queue-fill";
        fill.style.width = `${pct}%`;
        track.appendChild(fill);
        const pctEl = document.createElement("span");
        pctEl.className = "sftp-queue-pct";
        pctEl.textContent = item.total > 0 ? `${pct}%` : formatSize(item.transferred);
        detail.append(track, pctEl);
        cancelAction = "tx-cancel";
        break;
      }
      case "queued":
        detail.textContent = t("sftp.queue.queued");
        cancelAction = "tx-cancel";
        break;
      case "done":
        detail.textContent = `✓ ${t("sftp.progress.done")}`;
        break;
      case "failed":
        detail.textContent = t("sftp.queue.failed");
        cancelAction = "tx-dismiss";
        break;
      case "cancelled":
        detail.textContent = t("sftp.transferCancelled");
        cancelAction = "tx-dismiss";
        break;
    }

    row.append(icon, name, detail);
    if (cancelAction) {
      const label =
        cancelAction === "tx-cancel" ? t("sftp.cancelTransfer") : t("common.close");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-icon btn-small sftp-queue-cancel";
      btn.dataset.action = cancelAction;
      btn.title = label;
      btn.setAttribute("aria-label", label);
      btn.textContent = "×"; // ×
      row.appendChild(btn);
    }
    return row;
  }
}

/** A client-side validation error shaped like the backend `AppError`, for the
 * quiet-skip paths in bulk operations (move-into-self, name collision, …). */
function validationError(message: string): AppError {
  return { code: "Validation", message } as AppError;
}

/** The short label for a bookmark chip: the path's last segment (root ⇒ `/`). */
function bookmarkLabel(path: string): string {
  if (path === "/" || path === "") return "/";
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/** Constructs and initializes the Files (SFTP) panel. */
export function initSftpPanel(options: SftpPanelOptions = {}): SftpPanel {
  const panel = new SftpPanel(options);
  void panel.init();
  return panel;
}
