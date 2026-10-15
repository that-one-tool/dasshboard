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
  sftpConnectedDevices,
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
  onSftpEditChanged,
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
import {
  confirm,
  prompt,
  chooseConflict,
  choosePermissions,
  chooseEditConflict,
} from "../ui/confirm";
import { connectIcon, disconnectIcon } from "../ui/icons";
import { joinRemote, parentOf, isLocalFileName, skippedSummary } from "./sftpFormat";
import { TransferQueue, type TransferItem } from "./transferQueue";
import { EditSessions, type EditTransferSpec } from "./editSessions";
import { renderEditList } from "./editList";
import { basename, join } from "@tauri-apps/api/path";
import { t, tp } from "../i18n";
import { remToPx } from "../ui/dom";
import { MIN_GRID_REM, wireSplitter, type WidthBounds } from "../ui/splitter";
import { sftpPanelMarkup } from "./panel/panelTemplate";
import { DirHistory } from "./panel/dirHistory";
import { DEFAULT_SORT, nextSort, viewEntries, type SortKey, type SortState } from "./panel/entryView";
import { EntrySelection } from "./panel/entrySelection";
import { findFreeName } from "./panel/freeName";
import { renderEntryRow, type EntryRowActions } from "./panel/entryRow";
import * as queueView from "./panel/queueView";
import { renderBookmarks, renderBookmarkToggle } from "./panel/bookmarksBar";

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

/** Panel width bounds, in rem so they scale with the root font size like the
 * rest of the layout. The panel's own width is user state (dragged, persisted)
 * and so is kept in px. */
/** The toolbar's nine icon buttons on one row: 9 × 1.875rem + 8 gaps + padding
 * + border = 22rem. Mirrored by `.sftp-panel { min-width }` in styles.css. */
const MIN_PANEL_REM = 22;
const DEFAULT_PANEL_REM = 22.5;
/** Absolute upper bound for a restored width (the live drag re-clamps against
 * the workspace row so the grid never disappears). */
const MAX_PANEL_REM = 125;

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
  private editsEl: HTMLElement | null = null;

  /** The background transfer queue: up/downloads run here while browsing stays
   * live. Rebuilt on every panel rebuild so its hooks close over fresh DOM refs. */
  private queue!: TransferQueue;
  /** Per-item auto-remove timers for completed transfers (id → timer). */
  private queueHideTimers = new Map<number, ReturnType<typeof setTimeout>>();

  /** `sftp_progress` event subscription (live while the panel exists). */
  private unlistenProgress: UnlistenFn | null = null;
  private unlistenEditChanged: UnlistenFn | null = null;
  /** Files open in an external editor (edit in place). */
  private edits: EditSessions;
  /** Settles the queued edit transfers that end without running (cancelled
   * while queued, or dropped on disconnect); an active one settles through its
   * own `run`. Keyed by queue item id. */
  private editTransfers = new Map<number, { deviceId: string; reject: (error: AppError) => void }>();
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
  private width = remToPx(DEFAULT_PANEL_REM);

  /** The directory currently listed. */
  private cwd = "/";
  /** The full listing from the backend, before the filter/sort view is applied. */
  private allEntries: SftpEntry[] = [];
  /** The entries currently rendered (filtered + sorted view of `allEntries`) —
   * mirrors DOM order for select-all + shift-range + kind lookup. */
  private currentEntries: SftpEntry[] = [];
  /** Active sort column + direction (folders always stay grouped on top). */
  private sort: SortState = DEFAULT_SORT;
  /** Live name filter for the current directory (cleared on navigation). */
  private filterText = "";
  /** The connected device's saved bookmark paths (loaded on connect). */
  private bookmarks: string[] = [];
  /** The checked entries; cleared on navigation. */
  private selection = new EntrySelection();
  /**
   * The pending Move ("cut") set: the source device + directory and the entry
   * names to move on the next Paste. Survives navigation (cut here → open a
   * folder → paste), but is tied to one connection.
   */
  private moveClipboard: { deviceId: string; dir: string; names: string[] } | null = null;
  private history = new DirHistory();
  /** True while a connect/list/transfer is in flight (disables the toolbar). */
  private busy = false;
  /** True while `sftpConnect` is in flight (the connect toggle is inert). */
  private connecting = false;
  /** Bumped by every connect attempt and every disconnect, so a connect that
   * resolves after the user closed/disconnected is recognised as stale. */
  private connectSeq = 0;

  /** The splitter lives outside the panel's replaced innerHTML, so its listener
   * survives a `buildPanel()` rebuild — wire it exactly once. */
  private splitterWired = false;
  /** Re-syncs the splitter's ARIA width values (set once wired). */
  private syncSplitterAria = (): void => {};

  constructor(private readonly options: SftpPanelOptions = {}) {
    this.panel = document.querySelector<HTMLElement>(".sftp-panel");
    this.splitter = document.querySelector<HTMLElement>(".sftp-splitter");
    this.queue = new TransferQueue({
      cancelActive: (deviceId) => void this.cancelActiveTransfer(deviceId),
      onChange: () => this.renderQueue(),
      onProgress: (item) => this.updateQueueRowProgress(item),
      onComplete: (item, ctx) => this.onTransferComplete(item, ctx),
    });
    this.edits = new EditSessions({
      runTransfer: (spec) => this.runEditTransfer(spec),
      confirm: (message) => confirm(message),
      chooseConflict: chooseEditConflict,
      onChange: () => this.onEditsChange(),
      onError: (err) => this.reportError(err),
      onSuccess: (message) => this.options.onSuccess?.(message),
    });
  }

  async init(): Promise<void> {
    this.buildPanel();
    void onSftpEditChanged((editId) => void this.edits.handleChange(editId)).then((un) => {
      this.unlistenEditChanged = un;
    });
    this.devices = (await this.listDevicesOrNull()) ?? [];
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
    this.width = Math.min(remToPx(MAX_PANEL_REM), Math.max(remToPx(MIN_PANEL_REM), s.width));
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

  /** Re-fetch devices and refresh the picker (device CRUD happened), and the
   * connected device's bookmarks (config reload). */
  async refresh(): Promise<void> {
    // Unreadable list: keep what we have rather than take the connected
    // device for deleted.
    const devices = await this.listDevicesOrNull();
    if (devices) await this.applyDevices(devices);
    // Another instance may have changed its bookmarks.
    if (this.activeDeviceId) await this.loadBookmarks(this.activeDeviceId);
  }

  private async applyDevices(devices: Device[]): Promise<void> {
    this.devices = devices;
    this.refreshDeviceSelect();
    // The active device may have been deleted out from under us.
    if (this.activeDeviceId && !devices.some((d) => d.id === this.activeDeviceId)) {
      await this.handleDisconnect();
    }
  }

  /**
   * Drop to the disconnected state if the backend no longer holds this panel's
   * connection — e.g. an update install closed every session and then failed.
   * A failed lookup keeps the current state.
   */
  async resyncConnection(): Promise<void> {
    const deviceId = this.activeDeviceId;
    if (!deviceId) return;
    const live = await sftpConnectedDevices().catch(() => [deviceId]);
    // The user may have switched devices while the lookup was in flight.
    if (this.activeDeviceId !== deviceId) return;
    if (!live.includes(deviceId)) await this.handleDisconnect();
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
    this.unlistenEditChanged?.();
    this.unlistenEditChanged = null;
    this.clearQueueHideTimers();
    this.clearIdleTimer();
  }

  /** Surface an operation's error, then check whether it failed because the
   * connection itself is gone (server closed it, network dropped). */
  private reportError(err: unknown): void {
    this.options.onError?.(err as AppError);
    void this.resyncConnection();
  }

  /** The saved devices, or `null` (reported) when they can't be read. */
  private async listDevicesOrNull(): Promise<Device[] | null> {
    try {
      return await listDevices();
    } catch (err) {
      this.options.onError?.(err as AppError);
      return null;
    }
  }

  /* ----- panel shell ------------------------------------------------------ */

  private buildPanel(): void {
    const panel = this.panel;
    if (!panel) return;
    panel.innerHTML = sftpPanelMarkup();

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
    this.editsEl = panel.querySelector(".sftp-edits");
    this.renderQueue();
    this.renderEdits();

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
      this.selection.clear();
      this.applyView();
    });

    panel.addEventListener("click", (e) => this.onPanelClick(e.target));

    this.wireSplitter();
    this.updateConnDot();

    // Live transfer progress (throttled events from the backend) → active item.
    void onSftpProgress((e) => this.queue.applyProgress(e.deviceId, e.transferred, e.total)).then(
      (un) => {
        this.unlistenProgress = un;
      },
    );
  }

  /** Run the clicked control's action. `Element`, not `HTMLElement`: a click
   * on a button's inline SVG targets an `SVGElement`. */
  private onPanelClick(target: EventTarget | null): void {
    if (!(target instanceof Element)) return;
    const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
    if (action) this.clickActions.get(action)?.(target);
  }

  /** Run `action` unless a connect/list/transfer is in flight. */
  private whenIdle(action: () => unknown): void {
    if (!this.busy) void action();
  }

  private readonly clickActions = new Map<string, (target: Element) => void>([
    ["hide", () => void this.hide()],
    ["collapse", () => this.setCollapsed(true)],
    ["expand", () => this.setCollapsed(false)],
    ["conn-toggle", () => this.handleConnToggle()],
    ["copy-path", () => void this.handleCopyPath()],
    ["back", () => this.whenIdle(() => this.goBack())],
    ["forward", () => this.whenIdle(() => this.goForward())],
    ["up", () => this.whenIdle(() => this.goUp())],
    ["refresh", () => this.whenIdle(() => this.loadDir(this.cwd))],
    ["upload", () => this.whenIdle(() => this.handleUpload())],
    ["upload-dir", () => this.whenIdle(() => this.handleUploadFolder())],
    ["mkdir", () => this.whenIdle(() => this.handleMkdir())],
    ["sort", (target) => this.onSortClick(target)],
    ["bookmark-toggle", () => this.whenIdle(() => this.handleBookmarkToggle())],
    ["bookmark-go", (target) => this.withPath(target, (path) => this.whenIdle(() => this.goTo(path)))],
    ["bookmark-del", (target) => this.withPath(target, (path) => void this.handleBookmarkRemove(path))],
    ["tx-cancel", (target) => this.withTransferId(target, (id) => this.queue.cancel(id))],
    ["tx-dismiss", (target) => this.withTransferId(target, (id) => this.dismissQueueItem(id))],
    ["tx-clear", () => this.clearFinishedTransfers()],
    ["select-all", () => this.toggleSelectAll()],
    ["bulk-download", () => this.whenIdle(() => this.handleBulkDownload())],
    ["bulk-cut", () => this.handleBulkCut()],
    ["bulk-paste", () => this.whenIdle(() => this.handleBulkPaste())],
    ["bulk-delete", () => this.whenIdle(() => this.handleBulkDelete())],
    ["bulk-clear", () => this.clearSelection()],
  ]);

  private onSortClick(target: Element): void {
    const key = target.closest<HTMLElement>("[data-sort]")?.dataset.sort;
    if (key === "name" || key === "size" || key === "modified") this.setSort(key);
  }

  private withPath(target: Element, action: (path: string) => void): void {
    const path = target.closest<HTMLElement>("[data-path]")?.dataset.path;
    if (path) action(path);
  }

  private withTransferId(target: Element, action: (id: number) => void): void {
    const id = Number(target.closest<HTMLElement>("[data-tx-id]")?.dataset.txId);
    if (Number.isFinite(id)) action(id);
  }

  private dismissQueueItem(id: number): void {
    const timer = this.queueHideTimers.get(id);
    if (timer) clearTimeout(timer);
    this.queueHideTimers.delete(id);
    this.queue.remove(id);
  }

  private clearFinishedTransfers(): void {
    this.clearQueueHideTimers();
    this.queue.clearFinished();
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
    if (!(await this.confirmEndEdits())) return;
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
    // (2.5rem) applies; an inline width would otherwise override it.
    panel.style.width = this.collapsed ? "" : `${this.width}px`;
    if (this.splitter) this.splitter.hidden = !this.panelOpen || this.collapsed;
    this.syncSplitterAria();
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
      if (!(await this.confirmEndEdits())) {
        this.syncDeviceSelect(); // put the picker back on the device we kept
        return;
      }
      await this.disconnectActive();
    }
    this.selectedDeviceId = deviceId;
    this.syncDeviceSelect();
    this.idleDisconnected = false;
    this.history.reset();
    this.setStatus(t("sftp.connecting"));
    const seq = ++this.connectSeq;
    this.connecting = true;
    this.setBusy(true);
    try {
      // A first-contact host key raises the global host-key dialog; on accept the
      // connect proceeds and resolves here.
      const startDir = await sftpConnect(deviceId);
      if (seq !== this.connectSeq) {
        this.dropStaleConnection(deviceId);
        return;
      }
      this.activeDeviceId = deviceId;
      this.updateConnDot();
      await this.loadBookmarks(deviceId);
      await this.goTo(startDir);
    } catch (err) {
      // A superseded attempt (the user moved on) must not touch the newer one.
      if (seq !== this.connectSeq) return;
      this.activeDeviceId = null;
      this.setStatus("");
      this.options.onError?.(err as AppError);
      this.renderDisconnectedState();
      this.updateConnDot();
    } finally {
      if (seq === this.connectSeq) this.finishConnect();
    }
  }

  /** Settle the panel after the current connect attempt ends either way. */
  private finishConnect(): void {
    this.connecting = false;
    this.setBusy(false);
    this.updateConnDot();
    this.persist(); // remember the (now-)selected device
  }

  /** Close a connection that finished opening after the user moved on (closed
   * the panel mid-connect), unless it is the one now on screen. */
  private dropStaleConnection(deviceId: string): void {
    if (this.activeDeviceId === deviceId) return;
    void sftpDisconnect(deviceId).catch(() => {});
  }

  /** Disconnect the live connection (if any) without touching panel visibility.
   * Idempotent and best-effort. */
  private async disconnectActive(): Promise<void> {
    const deviceId = this.activeDeviceId;
    this.activeDeviceId = null;
    this.connectSeq += 1; // a connect still in flight is now stale
    this.connecting = false;
    this.setBusy(false); // …and will never clear `busy` itself
    this.moveClipboard = null; // a pending move is tied to this connection
    this.bookmarks = []; // bookmarks are loaded per active device
    this.renderBookmarks();
    this.updateBookmarkButton();
    if (deviceId) {
      // Cancel + drop any transfers for this device — the connection is going
      // away, so nothing more can run against it.
      this.queue.cancelDevice(deviceId);
      this.rejectEditTransfers(deviceId);
      this.edits.closeDevice(deviceId); // the backend ends them with the connection
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
    if (this.connecting) return;
    if (this.activeDeviceId) {
      void this.confirmThenDisconnect();
    } else if (this.selectedDeviceId) {
      void this.selectDevice(this.selectedDeviceId, true);
    }
  }

  /** The user's Disconnect: ask first when edited files have changes not
   * uploaded (disconnecting ends the edits). */
  private async confirmThenDisconnect(): Promise<void> {
    if (await this.confirmEndEdits()) await this.handleDisconnect();
  }

  /** Whether closing the active connection may end its edits: true unless some
   * have saved changes not uploaded and the user declines. */
  private async confirmEndEdits(): Promise<boolean> {
    const deviceId = this.activeDeviceId;
    const count = deviceId ? this.edits.unsyncedCount(deviceId) : 0;
    return count === 0 || confirm(tp("sftp.edit.disconnectConfirm", count));
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
    // An open edit keeps the connection: its saves still need uploading.
    if (!this.activeDeviceId || this.edits.hasEdits(this.activeDeviceId)) return;
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
   * List `path` and render it as the current directory; `true` once it shows.
   * Does NOT touch the Back/Forward history — used for Refresh,
   * post-operation re-listing, and as the shared worker behind
   * `goTo`/`goBack`/`goForward`.
   */
  private async loadDir(path: string): Promise<boolean> {
    const deviceId = this.activeDeviceId;
    if (deviceId === null) return false;
    // Re-listing the same directory (Refresh, or an auto-refresh after a
    // transfer) keeps any live filter; navigating to a different directory
    // starts fresh.
    const sameDir = path === this.cwd;
    // A new listing invalidates the selection (names are directory-relative).
    this.selection.clear();
    this.setBusy(true);
    try {
      const entries = await sftpList(deviceId, path);
      // Disconnected (or switched device) while the listing was in flight.
      if (this.activeDeviceId !== deviceId) return false;
      this.cwd = path;
      this.allEntries = entries;
      if (!sameDir) {
        this.filterText = "";
        if (this.filterEl) this.filterEl.value = "";
      }
      this.syncPathInput();
      this.applyView(); // renders + sets the count status
      this.updateBookmarkButton();
      return true;
    } catch (err) {
      if (this.activeDeviceId === deviceId) this.reportError(err);
      return false;
    } finally {
      this.setBusy(false); // also reconciles Back/Forward enabled state
    }
  }

  /** Render the filtered + sorted view of `allEntries`, the sort-header
   * indicators and the visible-count status. */
  private applyView(): void {
    const shown = viewEntries(this.allEntries, this.filterText, this.sort);
    this.renderEntries(shown);
    this.updateSortHeaders();
    this.setStatus(tp("sftp.count", shown.length));
  }

  private setSort(key: SortKey): void {
    this.sort = nextSort(this.sort, key);
    this.selection.forgetAnchor();
    this.applyView();
  }

  /** Reflect the active sort key + direction on the header buttons (an arrow on
   * the active one; `aria-sort` for assistive tech). */
  private updateSortHeaders(): void {
    this.panel?.querySelectorAll<HTMLButtonElement>('[data-action="sort"]').forEach((btn) => {
      const active = btn.dataset.sort === this.sort.key;
      const arrow = active ? (this.sort.dir === "asc" ? " ▲" : " ▼") : "";
      const label = t(`sftp.sort.${btn.dataset.sort as "name" | "size" | "modified"}`);
      btn.textContent = label + arrow;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-sort", active ? (this.sort.dir === "asc" ? "ascending" : "descending") : "none");
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

  /** Render the bookmark chips (hidden when none or not connected). */
  private renderBookmarks(): void {
    if (!this.bookmarksEl) return;
    const paths = this.activeDeviceId === null ? [] : this.bookmarks;
    renderBookmarks(this.bookmarksEl, paths, this.cwd);
  }

  /** Swap the toolbar star between add/remove per whether cwd is bookmarked. */
  private updateBookmarkButton(): void {
    const btn = this.panel?.querySelector<HTMLElement>(".sftp-bookmark-toggle");
    if (!btn) return;
    renderBookmarkToggle(btn, this.activeDeviceId !== null && this.bookmarks.includes(this.cwd));
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
      this.reportError(err);
    }
  }

  /** Remove a bookmark from its chip's × button. */
  private async handleBookmarkRemove(path: string): Promise<void> {
    if (this.activeDeviceId === null) return;
    try {
      this.bookmarks = await sftpBookmarkRemove(this.activeDeviceId, path);
      this.updateBookmarkButton();
    } catch (err) {
      this.reportError(err);
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
      this.reportError(err);
    }
  }

  /**
   * Navigate to a new directory and, once it shows, record it in history
   * (dropping any forward entries). Navigating to the current directory only
   * re-lists it.
   */
  private async goTo(path: string): Promise<void> {
    const isCurrent = this.history.isCurrent(path);
    if (!(await this.loadDir(path)) || isCurrent) return;
    this.history.record(path);
    this.updateNavButtons();
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
      this.reportError(err);
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
      this.reportError(err);
    }
  }

  /** Step back to the previous directory in history (no-op at the start). */
  private async goBack(): Promise<void> {
    await this.revisit(this.history.backTarget(), () => this.history.stepBack());
  }

  /** Step forward to the next directory in history (no-op at the end). */
  private async goForward(): Promise<void> {
    await this.revisit(this.history.forwardTarget(), () => this.history.stepForward());
  }

  /** List a directory from history, moving the cursor only once it shows. */
  private async revisit(target: string | undefined, step: () => void): Promise<void> {
    if (target === undefined || !(await this.loadDir(target))) return;
    step();
    this.updateNavButtons();
  }

  private async goUp(): Promise<void> {
    if (this.activeDeviceId === null) return;
    try {
      // Resolve `<cwd>/..` server-side so symlinked paths go to the real parent.
      const parent = await sftpRealpath(this.activeDeviceId, parentOf(this.cwd));
      if (parent !== this.cwd) await this.goTo(parent);
    } catch (err) {
      this.reportError(err);
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
    if (this.refuseUnsafeNames([entry])) return;
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

  /** Downloads a folder tree, then reports any entries it had to skip (one
   * odd entry doesn't stop the rest). */
  private async downloadFolder(
    deviceId: string,
    remote: string,
    target: string,
    policy: ConflictPolicy,
  ): Promise<void> {
    const skipped = await sftpDownloadDir(deviceId, remote, target, policy);
    if (skipped.length === 0) return;
    const name = remote.split("/").pop() ?? remote;
    const message = tp("sftp.download.skipped", skipped.length, { name, items: skippedSummary(skipped) });
    this.options.onError?.({ code: "Sftp", message });
  }

  /** Uploads a folder tree, then reports any entries it had to skip. */
  private async uploadFolder(
    deviceId: string,
    localDir: string,
    target: string,
    policy: ConflictPolicy,
  ): Promise<void> {
    const skipped = await sftpUploadDir(deviceId, localDir, target, policy);
    if (skipped.length === 0) return;
    const name = target.split("/").pop() ?? target;
    const message = tp("sftp.upload.skipped", skipped.length, { name, items: skippedSummary(skipped) });
    this.options.onError?.({ code: "Sftp", message });
  }

  /** Reports the first entry whose name can't be a local file name (see
   * `isLocalFileName`); true when the download must not go ahead. */
  private refuseUnsafeNames(entries: SftpEntry[]): boolean {
    const unsafe = entries.find((entry) => !isLocalFileName(entry.name));
    if (!unsafe) return false;
    const message = t("sftp.download.unsafeName", { name: unsafe.name });
    this.options.onError?.({ code: "Validation", message });
    return true;
  }

  /** Open a remote file in the external editor (edit in place). */
  private async handleEdit(entry: SftpEntry): Promise<void> {
    if (this.activeDeviceId === null) return;
    this.clearHover();
    const remote = joinRemote(this.cwd, entry.name);
    await this.edits.open(this.activeDeviceId, remote, entry.name);
  }

  /** Run an edit's download/upload through the transfer queue, settling with
   * its result. A failure is reported by the queue (`onTransferComplete`). */
  private runEditTransfer<T>(spec: EditTransferSpec<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.queue.enqueue({
        deviceId: spec.deviceId,
        direction: spec.direction,
        isDir: false,
        name: spec.name,
        cancellable: spec.cancellable,
        run: () => spec.run().then(resolve, (err: unknown) => {
          reject(err);
          throw err;
        }),
      });
      this.editTransfers.set(id, { deviceId: spec.deviceId, reject });
    });
  }

  private onEditsChange(): void {
    this.renderEdits();
    // The last edit ending lets a collapsed panel idle out again (and a new
    // one stops the countdown).
    if (this.collapsed) this.armIdleTimer();
  }

  private renderEdits(): void {
    if (!this.editsEl) return;
    renderEditList(this.editsEl, this.edits.entries(), {
      onReopen: (editId) => void this.edits.relaunch(editId),
      onStop: (editId) => void this.edits.stop(editId),
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
      run: () => this.uploadFile(deviceId, local, remote, name),
      successToast: t("sftp.uploadedToast", { name }),
      refreshDir: dir,
    });
  }

  /** Recursively download a folder into a chosen local directory, resolving a
   * name clash with a per-operation conflict policy. */
  private async handleDownloadFolder(entry: SftpEntry): Promise<void> {
    if (this.activeDeviceId === null) return;
    this.clearHover();
    if (this.refuseUnsafeNames([entry])) return;
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
      run: () => this.downloadFolder(deviceId, remote, target, policy),
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
      run: () => this.uploadFolder(deviceId, localDir, target, policy),
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

  /** Uploads one file, choosing where when its turn comes, not when it was
   * picked: a transfer ahead in the queue may create a file of that name
   * meanwhile. Skipping or cancelling the conflict dialog ends the item as a
   * quiet cancel. */
  private async uploadFile(deviceId: string, local: string, remote: string, name: string): Promise<void> {
    const target = await this.uploadTarget(deviceId, remote, name);
    if (target === null) throw { code: "Cancelled", message: "" } satisfies AppError;
    await sftpUpload(deviceId, local, target);
  }

  /** Where a single-file upload goes: `remote` itself, or — when a file of
   * that name is already there — what the conflict dialog picks (`null` to
   * upload nothing). */
  private async uploadTarget(deviceId: string, remote: string, name: string): Promise<string | null> {
    const exists = await sftpExists(deviceId, remote);
    const policy = await this.resolvePolicy(exists, t("sftp.conflict.message", { name }));
    if (policy === "rename") return this.freshRemoteName(deviceId, remote, name);
    return policy === "overwrite" ? remote : null;
  }

  /** A free `<path> (N)` on the server (`path` itself is taken). */
  private async freshRemoteName(deviceId: string, path: string, name: string): Promise<string> {
    const free = await findFreeName(path, (candidate) => sftpExists(deviceId, candidate));
    if (free !== null) return free;
    throw { code: "Sftp", message: t("sftp.upload.noFreeName", { name }) } satisfies AppError;
  }

  /** `path`, or a free `<path> (N)` when it exists locally (the per-file
   * rename policy in a bulk download). */
  private async freshLocalName(path: string, name: string): Promise<string> {
    if (!(await sftpLocalExists(path))) return path;
    const free = await findFreeName(path, sftpLocalExists);
    if (free !== null) return free;
    throw { code: "Sftp", message: t("sftp.download.noFreeName", { name }) } satisfies AppError;
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
    this.settleEditTransfer(item);
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
      this.reportError(item.error);
    }
    // "cancelled": quiet — the row stays until dismissed/cleared.
  }

  /** Reject an edit transfer the queue ended without running it to success
   * (cancelled while queued), so the edit doesn't wait on it forever. */
  private settleEditTransfer(item: TransferItem): void {
    const pending = this.editTransfers.get(item.id);
    this.editTransfers.delete(item.id);
    if (item.state === "done") return;
    pending?.reject(item.error ?? cancelledError());
  }

  /** Settle a device's edit transfers that `queue.cancelDevice` dropped
   * without completing them. */
  private rejectEditTransfers(deviceId: string): void {
    for (const [id, pending] of this.editTransfers) {
      if (pending.deviceId !== deviceId) continue;
      this.editTransfers.delete(id);
      pending.reject(cancelledError());
    }
  }

  /** Queue hook: ask the backend to cancel the in-flight transfer for a device. */
  private async cancelActiveTransfer(deviceId: string): Promise<void> {
    try {
      await sftpCancelTransfer(deviceId);
    } catch (err) {
      this.reportError(err);
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
      this.reportError(err);
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
      this.reportError(err);
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
      this.reportError(err);
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
    this.selection.clear();
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
    this.selection.toggle(this.currentEntries, index, shift);
    this.syncSelectionDom();
  }

  /** Select every entry when not all are selected, else clear (the header box). */
  private toggleSelectAll(): void {
    this.selection.toggleAll(this.currentEntries);
    this.syncSelectionDom();
  }

  private clearSelection(): void {
    this.selection.clear();
    this.syncSelectionDom();
  }

  /** Push the selection state onto the row checkboxes + the bulk bar. */
  private syncSelectionDom(): void {
    this.listEl
      ?.querySelectorAll<HTMLElement>(".sftp-entry")
      .forEach((row, i) => {
        const check = row.querySelector<HTMLInputElement>(".sftp-entry-check");
        if (check) check.checked = this.selection.has(this.currentEntries[i]?.name ?? "");
      });
    this.updateBulkBar();
  }

  /** Reflect selection count + clipboard onto the bulk bar (count, enabled
   * actions, Paste visibility). */
  private updateBulkBar(): void {
    const n = this.selection.size;
    if (this.selCountEl) {
      this.selCountEl.textContent = n > 0 ? tp("sftp.selected", n) : t("sftp.selectAll");
    }
    if (this.selectAllEl) {
      this.selectAllEl.checked = this.selection.allSelected(this.currentEntries);
      this.selectAllEl.indeterminate = n > 0 && n < this.currentEntries.length;
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
    return this.selection.selectedIn(this.currentEntries);
  }

  /** Download every selected entry into one chosen local folder — files
   * directly, folders recursively — under a single conflict policy. Sequential,
   * with the shared progress bar per file. */
  private async handleBulkDownload(): Promise<void> {
    if (this.activeDeviceId === null) return;
    const entries = this.selectedEntries();
    if (entries.length === 0) return;
    this.clearHover();
    if (this.refuseUnsafeNames(entries)) return;
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
          run: () => this.downloadFolder(deviceId, remote, target, policy),
        });
      } else {
        this.queue.enqueue({
          deviceId,
          direction: "download",
          isDir: false,
          name: entry.name,
          run: async () => {
            if (policy === "skip" && (await sftpLocalExists(target))) return;
            const local = policy === "rename" ? await this.freshLocalName(target, entry.name) : target;
            await sftpDownload(deviceId, remote, local);
          },
        });
      }
    }
    this.clearSelection();
  }

  /** "Cut": record the selection for a later Paste, then clear it. */
  private handleBulkCut(): void {
    if (this.activeDeviceId === null || this.selection.size === 0) return;
    this.moveClipboard = {
      deviceId: this.activeDeviceId,
      dir: this.cwd,
      names: this.selection.names(),
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
    if (this.activeDeviceId === null || this.selection.size === 0) return;
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
      this.reportError(firstError);
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
      const checked = this.selection.has(entry.name);
      this.listEl?.appendChild(renderEntryRow(entry, index, checked, this.rowActions));
    });
    this.updateBulkBar();
  }

  private readonly rowActions: EntryRowActions = {
    isBusy: () => this.busy,
    onCheck: (index, shift) => this.onCheckToggle(index, shift),
    onOpen: (entry) =>
      void (entry.kind === "dir" ? this.goTo(joinRemote(this.cwd, entry.name)) : this.handleDownload(entry)),
    onDownload: (entry) =>
      void (entry.kind === "dir" ? this.handleDownloadFolder(entry) : this.handleDownload(entry)),
    onEdit: (entry) => void this.handleEdit(entry),
    onRename: (entry) => void this.handleRename(entry),
    onPermissions: (entry) => void this.handlePermissions(entry),
    onDelete: (entry) => void this.handleDelete(entry),
  };

  /* ----- splitter (resize) ------------------------------------------------ */

  private wireSplitter(): void {
    const splitter = this.splitter;
    if (!splitter || this.splitterWired) return;
    this.splitterWired = true;
    this.syncSplitterAria = wireSplitter(splitter, {
      side: "end",
      // The rendered width: CSS `max-width` can show the panel narrower than
      // the stored width, and a drag must start from what the user sees.
      currentWidth: () => this.panel?.getBoundingClientRect().width || this.width,
      bounds: () => this.widthBounds(),
      defaultWidth: () => remToPx(DEFAULT_PANEL_REM),
      onResize: (width) => {
        this.width = width;
        if (this.panel) this.panel.style.width = `${width}px`;
        this.options.onLayoutChange?.();
      },
      onCommit: () => this.persist(), // save once per drag / key step, not per move
    });
  }

  /** `[MIN_PANEL_REM, workspace − splitter − MIN_GRID_REM]`: the grid keeps its floor. */
  private widthBounds(): WidthBounds {
    const row = this.panel?.parentElement?.getBoundingClientRect().width ?? 0;
    const handle = this.splitter?.getBoundingClientRect().width ?? 0;
    return {
      min: remToPx(MIN_PANEL_REM),
      max: row - handle - remToPx(MIN_GRID_REM),
    };
  }

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
      // Mid-connect, or disconnected with no device chosen yet → inert.
      btn.disabled = this.connecting || (!connected && !this.selectedDeviceId);
      btn.innerHTML = connected ? disconnectIcon : connectIcon;
      const label = connected ? t("sftp.disconnect") : t("sftp.connect");
      btn.title = label;
      btn.setAttribute("aria-label", label);
    }
    this.syncControls();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.syncControls();
  }

  /** Enable the browsing controls (toolbar, path, filter, sort) only when
   * connected and idle; the device picker only needs idle. */
  private syncControls(): void {
    const off = this.busy || this.activeDeviceId === null;
    this.panel
      ?.querySelectorAll<HTMLButtonElement>('.sftp-toolbar .btn, [data-action="sort"]')
      .forEach((b) => {
        b.disabled = off;
      });
    if (this.pathEl) this.pathEl.readOnly = off;
    if (this.filterEl) this.filterEl.disabled = off;
    if (this.deviceSelectEl) this.deviceSelectEl.disabled = this.busy;
    if (!off) this.updateNavButtons();
  }

  /** Enable/disable Back and Forward per the history cursor (idle state only). */
  private updateNavButtons(): void {
    const back = this.panel?.querySelector<HTMLButtonElement>('[data-action="back"]');
    const forward = this.panel?.querySelector<HTMLButtonElement>('[data-action="forward"]');
    if (back) back.disabled = !this.history.canGoBack();
    if (forward) forward.disabled = !this.history.canGoForward();
  }

  /* ----- transfer queue rendering ---------------------------------------- */

  /** Rebuild the transfer list; called on every queue change and after a
   * panel rebuild. */
  private renderQueue(): void {
    if (this.queueEl) queueView.renderQueue(this.queueEl, this.queue.items());
  }

  /** A progress tick: update the row in place, or re-render if it isn't there. */
  private updateQueueRowProgress(item: TransferItem): void {
    if (this.queueEl && !queueView.updateQueueRowProgress(this.queueEl, item)) this.renderQueue();
  }
}

/** A client-side validation error shaped like the backend `AppError`, for the
 * quiet-skip paths in bulk operations (move-into-self, name collision, …). */
function cancelledError(): AppError {
  return { code: "Cancelled", message: t("sftp.transferCancelled") };
}

function validationError(message: string): AppError {
  return { code: "Validation", message } as AppError;
}

/** Constructs and initializes the Files (SFTP) panel. */
export function initSftpPanel(options: SftpPanelOptions = {}): SftpPanel {
  const panel = new SftpPanel(options);
  void panel.init();
  return panel;
}
