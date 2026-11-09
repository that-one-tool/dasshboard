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
 *
 * `SftpPanel` wires the parts in `panel/` together and owns the panel's
 * visibility; each part owns one concern.
 */

import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  listDevices,
  onSftpEditChanged,
  onSftpProgress,
  type AppError,
  type Device,
  type SftpPanelState,
} from "../ipc";
import { confirm, chooseEditConflict } from "../ui/confirm";
import { EditSessions } from "./editSessions";
import { renderEditList } from "./editList";
import { joinRemote } from "./sftpFormat";
import { BulkActions } from "./panel/bulkActions";
import { DevicePicker } from "./panel/devicePicker";
import { DirectoryBrowser } from "./panel/directoryBrowser";
import { DirHistory } from "./panel/dirHistory";
import { EntryList } from "./panel/entryList";
import { EntryOperations } from "./panel/entryOperations";
import type { EntryRowActions } from "./panel/entryRow";
import { IdleDisconnect } from "./panel/idleDisconnect";
import { MoveClipboard } from "./panel/moveClipboard";
import { PanelBookmarks } from "./panel/panelBookmarks";
import { PanelConnection } from "./panel/panelConnection";
import { PanelControls } from "./panel/panelControls";
import { buildPanelElements, type PanelElements } from "./panel/panelElements";
import { withPath, withSortKey, withTransferId, wireActionClicks, wireControlEvents } from "./panel/panelEvents";
import { PanelFeedback } from "./panel/panelFeedback";
import { PanelSession } from "./panel/panelSession";
import { PanelShell } from "./panel/panelShell";
import { QueueController } from "./panel/queueController";
import { TransferActions } from "./panel/transferActions";

export { browsableDevices } from "./panel/devicePicker";

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

export class SftpPanel {
  // Setup order: the parts below are field initializers, so an eager
  // reference may only name a field declared above it (TypeScript checks this,
  // TS2729); references to later parts and to `options` (assigned after the
  // fields) go inside callbacks only.

  /** The docked panel; without it (a page that lacks it) the panel is inert:
   * every public method returns at once. */
  private readonly root = document.querySelector<HTMLElement>(".sftp-panel");
  /** The panel's controls, built by `init` (and rebuilt on a language change). */
  private els!: PanelElements;
  private readonly session = new PanelSession();
  private readonly history = new DirHistory();
  private readonly clipboard = new MoveClipboard();
  private readonly feedback = new PanelFeedback({
    notifyError: (error) => this.options.onError?.(error),
    notifySuccess: (message) => this.options.onSuccess?.(message),
    resync: () => void this.resyncConnection(),
  });
  private readonly controls = new PanelControls(() => this.els, this.session, this.history);
  // An inert panel never applies its layout, so its stand-in root never shows.
  private readonly shell = new PanelShell(this.root ?? document.createElement("aside"), document.querySelector<HTMLElement>(".sftp-splitter"), {
    onResize: () => this.notifyLayout(),
    onCommit: () => this.persist(),
  });
  private readonly picker = new DevicePicker(() => this.els, this.session);
  private readonly queue = new QueueController({
    els: () => this.els,
    feedback: this.feedback,
    onLanded: (deviceId, dir) => this.browser.refreshIfShowing(deviceId, dir),
  });
  /** Files open in an external editor (edit in place). */
  private readonly edits = new EditSessions({
    runTransfer: (spec) => this.queue.edits.run(spec),
    confirm: (message) => confirm(message),
    chooseConflict: chooseEditConflict,
    onChange: () => this.onEditsChange(),
    onError: (err) => this.feedback.report(err),
    onSuccess: (message) => this.feedback.success(message),
  });
  private readonly rowActions: EntryRowActions = {
    isBusy: () => this.controls.isBusy(),
    onCheck: (index, shift) => this.list.toggleCheck(index, shift),
    onOpen: (entry) => void (entry.kind === "dir" ? this.openDir(entry.name) : this.transfers.download(entry)),
    onDownload: (entry) =>
      void (entry.kind === "dir" ? this.transfers.downloadFolder(entry) : this.transfers.download(entry)),
    onEdit: (entry) => void this.operations.edit(entry),
    onRename: (entry) => void this.operations.rename(entry),
    onPermissions: (entry) => void this.operations.permissions(entry),
    onDelete: (entry) => void this.operations.delete(entry),
  };
  private readonly list: EntryList = new EntryList({
    els: () => this.els,
    rowActions: this.rowActions,
    canPaste: () => this.clipboard.canPasteInto(this.session.activeDeviceId, this.browser.cwd()),
  });
  private readonly bookmarks: PanelBookmarks = new PanelBookmarks({
    els: () => this.els,
    session: this.session,
    feedback: this.feedback,
    cwd: () => this.browser.cwd(),
  });
  private readonly browser: DirectoryBrowser = new DirectoryBrowser({
    els: () => this.els,
    session: this.session,
    controls: this.controls,
    history: this.history,
    list: this.list,
    feedback: this.feedback,
    onListed: () => this.bookmarks.render(),
  });
  private readonly transfers = new TransferActions({
    feedback: this.feedback,
    enqueue: (spec) => this.queue.enqueue(spec),
    place: () => this.browser.place(),
    isAt: (place) => this.browser.isAt(place),
    clearHover: () => this.list.clearHover(),
  });
  private readonly operations = new EntryOperations({
    browser: this.browser,
    feedback: this.feedback,
    edits: this.edits,
    clearHover: () => this.list.clearHover(),
  });
  private readonly bulk = new BulkActions({
    session: this.session,
    browser: this.browser,
    list: this.list,
    controls: this.controls,
    feedback: this.feedback,
    transfers: this.transfers,
    clipboard: this.clipboard,
  });
  private readonly connection: PanelConnection = new PanelConnection({
    session: this.session,
    controls: this.controls,
    history: this.history,
    feedback: this.feedback,
    unsyncedEdits: (deviceId) => this.edits.unsyncedCount(deviceId),
    onConnected: (deviceId, startDir) => this.onConnected(deviceId, startDir),
    onReleased: (deviceId) => this.releaseDevice(deviceId),
    showDisconnected: () => this.browser.showDisconnected(),
    syncPicker: () => this.picker.sync(),
    clearIdle: () => this.idle.clear(),
    persist: () => this.persist(),
  });
  private readonly idle: IdleDisconnect = new IdleDisconnect({
    session: this.session,
    controls: this.controls,
    timeoutMinutes: () => this.options.getIdleDisconnectMins?.() ?? 0,
    hasEdits: (deviceId) => this.edits.hasEdits(deviceId),
    disconnect: () => this.connection.disconnectActive(),
    showDisconnected: () => this.browser.showDisconnected(),
  });

  /** Backend event subscriptions (`sftp_progress`, `sftp_edit_changed`), live
   * while the panel exists. */
  private subscriptions: Promise<UnlistenFn>[] = [];

  private readonly clickActions = new Map<string, (target: Element) => void>([
    ["hide", () => void this.hide()],
    ["collapse", () => this.setCollapsed(true)],
    ["expand", () => this.setCollapsed(false)],
    ["conn-toggle", () => this.connection.toggle()],
    ["copy-path", () => void this.browser.copyPath()],
    ["back", () => this.whenIdle(() => this.browser.goBack())],
    ["forward", () => this.whenIdle(() => this.browser.goForward())],
    ["up", () => this.whenIdle(() => this.browser.goUp())],
    ["refresh", () => this.whenIdle(() => this.browser.reload())],
    ["upload", () => this.whenIdle(() => this.transfers.upload())],
    ["upload-dir", () => this.whenIdle(() => this.transfers.uploadFolder())],
    ["mkdir", () => this.whenIdle(() => this.operations.mkdir())],
    ["sort", (target) => withSortKey(target, (key) => this.browser.setSort(key))],
    ["bookmark-toggle", () => this.whenIdle(() => this.bookmarks.toggle())],
    ["bookmark-go", (target) => withPath(target, (path) => this.whenIdle(() => this.browser.goTo(path)))],
    ["bookmark-del", (target) => withPath(target, (path) => void this.bookmarks.remove(path))],
    ["tx-cancel", (target) => withTransferId(target, (id) => this.queue.cancel(id))],
    ["tx-dismiss", (target) => withTransferId(target, (id) => this.queue.dismiss(id))],
    ["tx-clear", () => this.queue.clearFinished()],
    ["select-all", () => this.list.toggleAll()],
    ["bulk-download", () => this.whenIdle(() => this.bulk.download())],
    ["bulk-cut", () => this.bulk.cut()],
    ["bulk-paste", () => this.whenIdle(() => this.bulk.paste())],
    ["bulk-delete", () => this.whenIdle(() => this.bulk.delete())],
    ["bulk-clear", () => this.list.clearSelection()],
  ]);

  constructor(private readonly options: SftpPanelOptions = {}) {
    if (this.root) this.listen(this.root);
  }

  async init(): Promise<void> {
    if (!this.root) return;
    this.build(this.root);
    this.picker.setDevices((await this.listDevicesOrNull()) ?? []);
    this.applyInitialState();
  }

  /** The persisted panel state, or `undefined` until the panel has been opened
   * (so the workspace file stays clean until the feature is used). */
  layoutState(): SftpPanelState | undefined {
    return this.shell.layout.persisted(this.session.shownDeviceId());
  }

  /** Re-fetch devices and refresh the picker (device CRUD happened), and the
   * connected device's bookmarks (config reload). */
  async refresh(): Promise<void> {
    if (this.root) await this.reloadDevices();
  }

  private async reloadDevices(): Promise<void> {
    // Unreadable list: keep what we have rather than take the connected
    // device for deleted.
    const devices = await this.listDevicesOrNull();
    if (devices) await this.applyDevices(devices);
    // Another instance may have changed its bookmarks.
    const deviceId = this.session.activeDeviceId;
    if (deviceId) await this.bookmarks.load(deviceId);
  }

  /** Drop to the disconnected state if the backend no longer holds this
   * panel's connection. A failed lookup keeps the current state. */
  async resyncConnection(): Promise<void> {
    if (this.root) await this.connection.resync();
  }

  /**
   * Rebuild the panel chrome in the current locale (language change), but only
   * while not connected: tearing down a live browse would be surprising, and a
   * language change is initiated from the settings dialog.
   */
  retranslate(): void {
    const root = this.rebuildableRoot();
    if (!root) return;
    this.build(root);
    this.picker.render();
    if (this.shell.layout.isOpen()) this.applyOpenState();
  }

  /** Stop listening for progress events + clear timers (tests; the app keeps the
   * panel for its lifetime). */
  dispose(): void {
    const subscriptions = this.subscriptions;
    this.subscriptions = [];
    for (const subscription of subscriptions) void subscription.then((unlisten) => unlisten());
    this.queue.dispose();
    this.idle.clear();
  }

  /** Whether the panel is currently shown (open, expanded or collapsed). */
  isOpen(): boolean {
    return this.shell.layout.isOpen();
  }

  /** Show the panel (expanded). Does not connect — the picker's disconnected
   * state offers a Connect button. */
  open(): void {
    if (!this.root) return;
    this.shell.layout.show();
    this.session.clearIdleDisconnected();
    this.applyOpenState();
    if (!this.session.isConnected()) this.browser.showDisconnected();
    this.notifyLayout();
    this.persist();
  }

  /** Open the panel and connect to a specific device (sidebar "Browse"). */
  openWith(deviceId: string): void {
    if (!this.root) return;
    this.open();
    void this.connection.select(deviceId);
  }

  /** Toggle the panel from the header button: open when hidden, fully close
   * (disconnecting) when shown. */
  toggle(): void {
    if (!this.root) return;
    if (this.shell.layout.isOpen()) void this.hide();
    else this.open();
  }

  /** Re-arm the idle timer if the setting changed while collapsed + connected. */
  onIdleSettingChange(): void {
    if (this.shell.layout.isCollapsed() && this.session.isConnected()) this.idle.arm();
  }

  /** Once per panel: the root and these events outlive every markup rebuild. */
  private listen(root: HTMLElement): void {
    wireActionClicks(root, (action, target) => this.clickActions.get(action)?.(target));
    this.subscriptions = [
      onSftpEditChanged((editId) => void this.edits.handleChange(editId)),
      // Live transfer progress (throttled events from the backend) → active item.
      onSftpProgress((e) => this.queue.applyProgress(e.deviceId, e.transferred, e.total)),
    ];
  }

  /** The root to rebuild in a new locale; none while connected (tearing down
   * a live browse would be surprising) or on an inert panel. */
  private rebuildableRoot(): HTMLElement | null {
    return this.session.isConnected() ? null : this.root;
  }

  private build(root: HTMLElement): void {
    this.els = buildPanelElements(root);
    this.queue.render();
    this.renderEdits();
    wireControlEvents(this.els, {
      onPathEnter: (path) => this.whenIdle(() => this.browser.goToPath(path)),
      onPathEscape: () => this.browser.syncPathInput(),
      onDeviceChange: (deviceId) => void this.connection.select(deviceId),
      onFilter: (text) => this.browser.setFilter(text),
    });
    this.shell.wireSplitter();
    this.controls.updateConnToggle();
  }


  /**
   * Restore the persisted panel state (open/collapsed/width + preselected
   * device). Never connects — a restored device is only preselected, so a
   * restart doesn't silently re-authenticate; the disconnected state offers a
   * one-click Reconnect.
   */
  private applyInitialState(): void {
    const saved = this.options.initialState;
    if (!saved) return;
    this.session.pickDevice(this.picker.knownBrowsable(saved.deviceId));
    if (!this.shell.restore(saved)) return;
    this.applyOpenState();
    this.picker.sync();
    this.browser.showDisconnected();
    this.notifyLayout();
  }

  private async applyDevices(devices: Device[]): Promise<void> {
    this.picker.setDevices(devices);
    // The active device may have been deleted out from under us.
    const deviceId = this.session.activeDeviceId;
    if (deviceId && !this.picker.hasDevice(deviceId)) await this.connection.disconnect();
  }

  /** The saved devices, or `null` (reported) when they can't be read. */
  private async listDevicesOrNull(): Promise<Device[] | null> {
    try {
      return await listDevices();
    } catch (err) {
      this.feedback.notify(err);
      return null;
    }
  }

  /** Run `action` unless a connect/list/transfer is in flight. */
  private whenIdle(action: () => unknown): void {
    if (!this.controls.isBusy()) void action();
  }

  private openDir(name: string): Promise<void> {
    return this.browser.goTo(joinRemote(this.browser.cwd(), name));
  }

  /** Fully close the panel: disconnect the live connection immediately (the
   * "closed" state's rule) and hide the panel + splitter. */
  private async hide(): Promise<void> {
    if (!(await this.connection.confirmEndEdits())) return;
    this.shell.layout.hide();
    this.idle.clear();
    this.applyOpenState();
    this.notifyLayout();
    this.persist();
    await this.connection.disconnectActive();
    this.els.list.replaceChildren();
  }

  /** Collapse to the rail (keeps the connection, arms the idle timer) or expand
   * back (clears it). A no-op when the panel is hidden. */
  private setCollapsed(collapsed: boolean): void {
    if (!this.shell.layout.setCollapsed(collapsed)) return;
    if (collapsed) this.idle.arm();
    else this.onExpand();
    this.applyOpenState();
    this.notifyLayout();
    this.persist();
  }

  /** Expanding stops the idle countdown and shows why an idle panel is
   * disconnected. */
  private onExpand(): void {
    this.idle.clear();
    if (this.session.idleDisconnected && !this.session.isConnected()) this.browser.showDisconnected();
  }

  private applyOpenState(): void {
    this.shell.apply();
    this.controls.updateConnToggle();
  }

  private async onConnected(deviceId: string, startDir: string): Promise<void> {
    await this.bookmarks.load(deviceId);
    await this.browser.goTo(startDir);
  }

  /** Drop what belonged to the closing connection. */
  private releaseDevice(deviceId: string | null): void {
    this.clipboard.clear(); // a pending move is tied to this connection
    this.bookmarks.clear();
    if (!deviceId) return;
    this.queue.cancelDevice(deviceId); // nothing more can run against it
    this.edits.closeDevice(deviceId); // the backend ends them with the connection
  }

  private onEditsChange(): void {
    this.renderEdits();
    // The last edit ending lets a collapsed panel idle out again (and a new
    // one stops the countdown).
    if (this.shell.layout.isCollapsed()) this.idle.arm();
  }

  private renderEdits(): void {
    renderEditList(this.els.edits, this.edits.entries(), {
      onReopen: (editId) => void this.edits.relaunch(editId),
      onStop: (editId) => void this.edits.stop(editId),
    });
  }

  private notifyLayout(): void {
    this.options.onLayoutChange?.();
  }

  /** Notify the caller that persisted state changed (debounced save). */
  private persist(): void {
    this.options.onPersist?.();
  }
}

/** Constructs and initializes the Files (SFTP) panel. */
export function initSftpPanel(options: SftpPanelOptions = {}): SftpPanel {
  const panel = new SftpPanel(options);
  void panel.init();
  return panel;
}
