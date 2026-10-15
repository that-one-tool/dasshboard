/**
 * The single SSH terminal pane (SPEC §7, Phase 2). Device dropdown + Connect;
 * on connect it creates a real xterm.js terminal wired to the backend session:
 * keystrokes → `write_stdin`, the session's output (`read_output`, pulled by an
 * `OutputReader`) → `terminal.write`, and
 * a `ResizeObserver` → fit addon → `resize_pty`. Status overlays (connecting
 * spinner; error/disconnected + Retry) react to `session_status` events.
 *
 * This class is the controller; its parts live in `pane/` (markup, overlay,
 * device dropdown, clipboard, terminal factory, session ownership) and the
 * reconnect policy in `reconnectBudget.ts`.
 */

import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  connect,
  disconnect,
  listDevices,
  onSessionStatus,
  readOutput,
  resizePty,
  saveTextFile,
  writeStdin,
  writeStdinBinary,
  type Device,
  type ErrorCode,
  type SessionStatus,
  type TerminalSettings,
} from "../ipc";
import { overlayForStatus } from "./overlay";
import { isTerminalReply } from "./terminalReplies";
import { SerialQueue } from "./inputQueue";
import { OutputReader } from "./outputReader";
import { DEFAULT_TERMINAL_SETTINGS } from "./terminalSettings";
import { errorCodeOf } from "./reconnect";
import { ReconnectBudget } from "./reconnectBudget";
import { isPasteShortcut } from "./paste";
import { linkHandlers } from "./links";
import { TerminalSearchBar, isFindShortcut } from "./searchBar";
import { bufferText, outputFileName } from "./scrollbackText";
import { paneMarkup, relabelPane } from "./pane/paneTemplate";
import { PaneOverlay } from "./pane/paneOverlay";
import { DeviceSelect } from "./pane/deviceSelect";
import { PaneClipboard } from "./pane/paneClipboard";
import { SessionSlot } from "./pane/sessionSlot";
import { applyTerminalOptions, makeTerminal } from "./pane/terminalFactory";
import { pickTextSavePath } from "../ui/fileDialog";
import { showToast } from "../ui/toast";
import { requireEl } from "../ui/dom";
import { t } from "../i18n";
import type { MessageKey } from "../i18n/en";
import { deviceEndpoint } from "../devices/deviceEndpoint";

// Re-exported so callers already importing them from this module keep working.
export { deviceEndpoint };
export { deviceOptionLabel } from "./pane/deviceSelect";

export interface TerminalPaneOptions {
  onError?: (message: string) => void;
  /**
   * Fired when this pane's saved-state (its assigned device) changes — i.e. the
   * user picks a device or connects one. The grid uses it to recompute the
   * profile dirty-state dot (Phase 4). Not fired for programmatic
   * `assignDevice()` during a profile load (the grid suppresses churn there).
   */
  onChange?: () => void;
  /** Fired whenever the status chip changes, and on dispose (the side menu's
   * connected-device count). */
  onStatusChange?: () => void;
  /**
   * Supplies the current terminal appearance settings (font, theme). Read when a
   * terminal is created so panes opened after a settings change use the new
   * values; live changes go through `applyTerminalSettings` (Phase 5).
   */
  getTerminalSettings?: () => TerminalSettings;
  /**
   * Fired with each chunk of *locally-typed* input (a keystroke or a paste)
   * once this pane is connected. The grid uses it to fan the input out to the
   * other connected panes when broadcast mode is on. Only real user input
   * triggers it — bytes injected via `sendInput` (the fan-out itself) go
   * straight to the PTY and never re-enter here, so there is no echo loop.
   */
  onInput?: (data: string) => void;
}

type PaneStatus = SessionStatus | "idle";

const STATUS_LABEL_KEYS: Record<PaneStatus, MessageKey> = {
  idle: "pane.status.idle",
  connecting: "pane.status.connecting",
  connected: "pane.status.connected",
  disconnected: "pane.status.disconnected",
  exited: "pane.status.exited",
  error: "pane.status.error",
};

export class TerminalPane {
  private readonly root: HTMLElement;
  private readonly options: TerminalPaneOptions;
  private devices: Device[] = [];

  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private unlistenStatus: (() => void) | null = null;
  private readonly overlay: PaneOverlay;
  private readonly deviceSelect: DeviceSelect;
  private readonly searchBar: TerminalSearchBar;
  private readonly clipboard: PaneClipboard;
  private readonly input = new SerialQueue();
  /** Pulls the current session's output into the terminal. */
  private output: OutputReader | null = null;
  /** The pane's own keys inside the terminal, each with what it does. */
  private readonly terminalKeys: Array<[(e: KeyboardEvent) => boolean, () => void]> = [
    // Ctrl+Shift+V paste (SPEC §7).
    [isPasteShortcut, () => this.clipboard.pasteFromShortcut()],
    [isFindShortcut, () => this.searchBar.open()],
  ];

  private readonly session = new SessionSlot();
  private deviceId: string | null = null;
  // Re-entrancy guard: `startSession()` mutates state across an
  // `await connect(...)` that can take seconds (a real SSH handshake). Without
  // this, a double-click on Connect re-enters while the first call is still
  // suspended, disposing the in-flight terminal, wiring the first session's
  // output into the new one, and orphaning the first call's backend session
  // (never reachable again). Mirrors `Grid.transitioning`.
  private connecting = false;
  // While a splitter drag is in progress the grid throttles PTY resizes: the
  // terminal still re-fits visually on every layout change, but `resize_pty` is
  // deferred to drag end (see grid.ts) to avoid spamming the backend.
  private resizeThrottled = false;

  // Auto-reconnect (Phase 5). `userInitiated` marks a disconnect the user (or a
  // grid teardown) asked for, so it is NOT treated as an unexpected drop.
  private userInitiated = false;
  private readonly reconnect = new ReconnectBudget(() => void this.startSession(true));
  /** Set by `dispose()`: a connect resolving afterwards must close its session. */
  private disposed = false;
  // Kept so `retranslate()` can relabel the header status chip.
  private paneStatus: PaneStatus = "idle";

  constructor(root: HTMLElement, options: TerminalPaneOptions = {}) {
    this.root = root;
    this.options = options;
    root.innerHTML = paneMarkup();
    this.overlay = new PaneOverlay(root);
    this.deviceSelect = new DeviceSelect(root, (deviceId) => this.pickDevice(deviceId));
    this.searchBar = this.makeSearchBar();
    this.clipboard = this.makeClipboard();
    this.renderStatus();
    this.wireButtons();
  }

  async init(): Promise<void> {
    this.unlistenStatus = await onSessionStatus((event) => {
      if (this.session.isOwnerOf(event.sessionId)) {
        this.applyStatus(event.status, event.message, event.code);
      }
    });
    await this.refreshDevices();
  }

  /** Reloads the device dropdown (call after devices are added/edited/deleted). */
  async refreshDevices(): Promise<void> {
    // A failed load is not "every device deleted": keep the list we have, or a
    // transient IPC error would drop every pane's live session.
    const devices = await listDevices().catch(() => null);
    if (devices) this.applyDevices(devices);
    this.deviceSelect.render(this.devices, this.deviceId);
    this.updateControls();
  }

  private applyDevices(devices: Device[]): void {
    this.devices = devices;
    // If the assigned device was deleted, drop the stale reference so it can't be
    // re-persisted into a profile on the next Save (referential integrity: the
    // backend already nulled it out of profiles.json, and getDeviceId() feeds the
    // profile snapshot). `onChange` lets the dirty-state dot recompute.
    if (!this.assignedDeviceWasDeleted()) return;
    this.deviceId = null;
    this.abandonSessionForDeletedDevice();
    this.options.onChange?.();
  }

  private assignedDeviceWasDeleted(): boolean {
    return !!this.deviceId && this.assignedDevice() === undefined;
  }

  private assignedDevice(): Device | undefined {
    return this.devices.find((d) => d.id === this.deviceId);
  }

  /**
   * The device we were connected to / reconnecting toward is gone: abandon any
   * pending auto-reconnect (there's nothing to reconnect to) and force down any
   * live session rather than merely hiding the overlay — leaving it open while
   * showing an idle dot would let the pane lie about being idle while a real
   * backend session is still open. Ends at the idle empty-pane state either way.
   */
  private abandonSessionForDeletedDevice(): void {
    this.reconnect.reset();
    this.closeCurrentSession();
    this.stopResizeObserver();
    this.hideOverlay();
  }

  private closeCurrentSession(): void {
    const sessionId = this.session.dropCurrent();
    if (sessionId) void disconnect(sessionId);
  }

  private makeSearchBar(): TerminalSearchBar {
    return new TerminalSearchBar(requireEl<HTMLElement>(this.root, ".pane-body"), {
      onClose: () => this.terminal?.focus(),
      theme: () => this.currentSettings().theme,
    });
  }

  private makeClipboard(): PaneClipboard {
    return new PaneClipboard(requireEl<HTMLElement>(this.root, ".pane-terminal"), {
      selection: () => this.terminal?.getSelection(),
      canPaste: () => this.session.isConnected() && this.terminal !== null,
      paste: (text) => this.terminal?.paste(text),
    });
  }

  private wireButtons(): void {
    const actions: Array<[string, () => void]> = [
      [".pane-connect", () => void this.startSession()],
      [".pane-disconnect", () => void this.disconnectSession()],
      [".pane-find", () => this.searchBar.open()],
      [".pane-save-output", () => void this.saveOutput()],
      [".overlay-retry", () => void this.startSession()],
      [".overlay-cancel", () => this.cancelReconnect()],
    ];
    for (const [selector, action] of actions) {
      requireEl<HTMLButtonElement>(this.root, selector).addEventListener("click", () => action());
    }
  }

  private pickDevice(deviceId: string): void {
    this.deviceId = deviceId;
    this.showEndpoint();
    this.options.onChange?.();
  }

  private updateControls(): void {
    const busy = this.session.current !== null;
    const connectBtn = requireEl<HTMLButtonElement>(this.root, ".pane-connect");
    connectBtn.hidden = busy;
    connectBtn.disabled = this.devices.length === 0;
    requireEl<HTMLButtonElement>(this.root, ".pane-disconnect").hidden = !busy;
    this.deviceSelect.setLocked(this.deviceLocked());
    // An ended session's terminal stays readable, so these outlive it.
    requireEl<HTMLButtonElement>(this.root, ".pane-find").disabled = !this.terminal;
    requireEl<HTMLButtonElement>(this.root, ".pane-save-output").disabled = !this.terminal;
    this.showEndpoint();
  }

  /** The device can't change while a session is open or still opening: the
   * pane would end up connected to one device while claiming another. */
  private deviceLocked(): boolean {
    return this.session.isBusy() || this.connecting;
  }

  private setStatus(status: PaneStatus): void {
    this.paneStatus = status;
    this.renderStatus();
    this.options.onStatusChange?.();
  }

  private renderStatus(): void {
    const chip = requireEl<HTMLElement>(this.root, ".pane-status");
    chip.className = `pane-status pane-status-${this.paneStatus}`;
    const label = t(STATUS_LABEL_KEYS[this.paneStatus]);
    requireEl<HTMLElement>(chip, ".pane-status-label").textContent = label;
    chip.title = label;
  }

  private async startSession(fromReconnect = false): Promise<void> {
    // Block re-entrancy for the whole attempt (through connect() resolving or
    // rejecting), not just until the button re-renders — see the `connecting`
    // field comment for why the async window is dangerous.
    if (this.connecting) return;
    this.connecting = true;
    try {
      await this.connectDevice(this.beginAttempt(fromReconnect));
    } finally {
      this.connecting = false;
      this.updateControls();
    }
  }

  /** Clears the way for a connect attempt; returns the device it targets. */
  private beginAttempt(fromReconnect: boolean): string | null {
    // A manual connect supersedes a pending auto-reconnect; left armed, its timer
    // would start a second session and dispose this one's terminal.
    if (!fromReconnect) this.reconnect.reset();
    // One session per pane: close whatever this one replaces.
    this.releaseSession();
    return fromReconnect ? this.reconnectDeviceId() : this.pickedDeviceId();
  }

  /** The initial manual connect may use the dropdown's own choice (user
   * picked from the dropdown, no change event yet). */
  private pickedDeviceId(): string | null {
    return this.deviceId ?? this.deviceSelect.value();
  }

  /** A reconnect must target the pane's *assigned* device only — never the
   * dropdown's fallback, which after a device deletion could be some other
   * device sitting at index 0. With nothing left to reconnect to, it says so
   * instead of hanging. */
  private reconnectDeviceId(): string | null {
    if (!this.deviceId) this.showDeviceGone();
    return this.deviceId;
  }

  private showDeviceGone(): void {
    this.reconnect.reset();
    this.overlay.show(() => overlayForStatus("error", t("pane.overlay.deviceGone")));
  }

  private async connectDevice(deviceId: string | null): Promise<void> {
    if (!deviceId) return;
    this.claimDevice(deviceId);
    const terminal = this.createSessionTerminal();
    // Immediate feedback before the backend's own `connecting` event arrives.
    this.applyStatus("connecting");
    this.setStatus("connecting");
    await this.establishConnection(deviceId, terminal);
  }

  /** Records the target device as this pane's assignment and clears drop state. */
  private claimDevice(deviceId: string): void {
    const deviceChanged = this.deviceId !== deviceId;
    this.deviceId = deviceId;
    // A fresh connect attempt: any drop that follows is unexpected (until the
    // user explicitly disconnects), so clear the user-initiated flag.
    this.userInitiated = false;
    // Connecting a device to a previously-empty pane changes the saved-state.
    if (deviceChanged) this.options.onChange?.();
  }

  /** Builds a fresh xterm.js terminal for a new connection attempt (no stale
   * scrollback from a prior session). */
  private createSessionTerminal(): Terminal {
    this.teardownTerminal();
    const terminalEl = requireEl<HTMLElement>(this.root, ".pane-terminal");
    const links = linkHandlers(terminalEl, openUrl, (message) => this.options.onError?.(message));
    const { terminal, fitAddon, searchAddon } = makeTerminal(terminalEl, this.currentSettings(), links);
    this.wireTerminalInput(terminal);
    this.terminal = terminal;
    this.fitAddon = fitAddon;
    this.searchBar.attach(searchAddon);
    return terminal;
  }

  private wireTerminalInput(terminal: Terminal): void {
    terminal.onData((data) => this.onTypedData(data));
    // Mouse reports that aren't UTF-8 (the legacy encoding): never mirrored.
    terminal.onBinary((data) => this.onTypedBinary(data));
    terminal.attachCustomKeyEventHandler((e) => this.onTerminalKey(e));
  }

  private onTypedData(data: string): void {
    const sessionId = this.session.writableId();
    if (!sessionId) return;
    this.write(sessionId, data);
    this.mirrorInput(data);
  }

  /** Lets the grid mirror what the user typed into other panes (broadcast
   * mode) — never the terminal's own query replies or mouse reports. */
  private mirrorInput(data: string): void {
    if (!isTerminalReply(data)) this.options.onInput?.(data);
  }

  private onTypedBinary(data: string): void {
    const sessionId = this.session.writableId();
    if (sessionId) this.input.push(() => writeStdinBinary(sessionId, data));
  }

  private currentSettings(): TerminalSettings {
    return this.options.getTerminalSettings?.() ?? DEFAULT_TERMINAL_SETTINGS;
  }

  /** Runs one of the pane's own keys; `false` keeps it from xterm. */
  private onTerminalKey(e: KeyboardEvent): boolean {
    if (e.type !== "keydown") return true;
    const key = this.terminalKeys.find(([matches]) => matches(e));
    if (key === undefined) return true;
    // Returning false only stops xterm; WebView2 would still run the key's
    // native action (Ctrl+Shift+V = a second, native paste).
    e.preventDefault();
    key[1]();
    return false;
  }

  /** Writes the scrollback + screen, as they are now, to a file the user picks. */
  private async saveOutput(): Promise<void> {
    if (!this.terminal) return;
    const text = bufferText(this.terminal.buffer.normal);
    const path = await pickTextSavePath(outputFileName(this.assignedDeviceName(), new Date()));
    if (path) await this.writeOutputFile(path, text);
  }

  private async writeOutputFile(path: string, text: string): Promise<void> {
    try {
      await saveTextFile(path, text);
      showToast(t("pane.saveOutput.saved", { path }), "success");
    } catch (err) {
      this.options.onError?.(errorMessage(err));
    }
  }

  private assignedDeviceName(): string {
    return this.assignedDevice()?.name ?? "";
  }

  /** Opens the backend session and wires its output into the terminal. */
  private async establishConnection(deviceId: string, terminal: Terminal): Promise<void> {
    const sessionId = crypto.randomUUID();
    this.session.open(sessionId);
    try {
      await connect(sessionId, deviceId, terminal.cols, terminal.rows);
      this.readOutputInto(sessionId, terminal);
      this.adoptSession(sessionId);
    } catch (err) {
      this.onConnectFailed(sessionId, err);
    }
  }

  private onConnectFailed(sessionId: string, err: unknown): void {
    // Released (cancelled / replaced) while opening: nothing left to report.
    if (!this.session.failOpen(sessionId)) return;
    const message = errorMessage(err);
    this.applyStatus("error", message, errorCodeOf(err));
    this.options.onError?.(message);
  }

  /** Pull the session's output into `terminal` until it ends or the terminal
   * is replaced. */
  private readOutputInto(sessionId: string, terminal: Terminal): void {
    this.output?.stop();
    const output = new OutputReader({
      read: (from) => readOutput(sessionId, from),
      write: (bytes) => this.writeOutput(terminal, bytes),
    });
    this.output = output;
    void output.run();
  }

  /** Resolves once xterm has processed `bytes` — only into the terminal the
   * session was opened with, never a later one. */
  private writeOutput(terminal: Terminal, bytes: Uint8Array): Promise<void> {
    if (this.terminal !== terminal) return Promise.resolve();
    return new Promise((resolve) => terminal.write(bytes, resolve));
  }

  /** Take ownership of a session `connect()` just opened — unless the pane
   * let go of it meanwhile (disposed, cancelled, replaced, or its terminal
   * status beat the command's return), in which case close it (a no-op for a
   * session that already ended). */
  private adoptSession(sessionId: string): void {
    if (this.disposed || !this.session.adopt(sessionId)) {
      void disconnect(sessionId);
      return;
    }
    this.updateControls();
    this.observeResize();
  }

  private observeResize(): void {
    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(requireEl<HTMLElement>(this.root, ".pane-terminal"));
  }

  private onResize(): void {
    this.fitAddon?.fit();
    if (!this.resizeThrottled) this.pushSize(this.session.writableId());
  }

  private pushSize(sessionId: string | null): void {
    if (sessionId && this.terminal) void resizePty(sessionId, this.terminal.cols, this.terminal.rows);
  }

  private async disconnectSession(): Promise<void> {
    // A user-requested disconnect is expected — don't auto-reconnect from it.
    this.userInitiated = true;
    this.reconnect.reset();
    const sessionId = this.session.current;
    if (sessionId) await disconnect(sessionId);
  }

  private applyStatus(status: SessionStatus, message?: string, code?: ErrorCode): void {
    this.setStatus(status);

    if (status === "connecting") {
      this.applyConnectingStatus(status, message);
    } else if (status === "connected") {
      this.applyConnectedStatus(status, message);
    } else {
      this.applyTerminatedStatus(status, message, code);
    }
  }

  /** During an auto-reconnect the connecting frame keeps the reconnect context
   * (attempt N of M + Cancel) rather than a bare "Connecting…". */
  private applyConnectingStatus(status: SessionStatus, message?: string): void {
    if (this.reconnect.isInProgress()) this.showReconnectOverlay();
    else this.overlay.show(() => overlayForStatus(status, message));
  }

  private applyConnectedStatus(status: SessionStatus, message?: string): void {
    this.session.markConnected();
    // A successful connect ends any reconnect sequence. Clear `userInitiated`
    // (a cancel-then-connect must not suppress reconnecting a *future* drop).
    this.reconnect.reset();
    this.userInitiated = false;
    this.terminal?.focus();
    // The backend drops resizes sent while connecting, so a layout change since
    // the PTY was requested (e.g. the startup layout settling) must be pushed now.
    this.syncSize();
    this.overlay.show(() => overlayForStatus(status, message));
  }

  /** disconnected | error: the session is over. Stop forwarding input and free
   * the frontend mirror; the terminal stays visible (frozen) under the overlay.
   * Schedules a backoff reconnect instead of the normal error overlay when the
   * drop was unexpected and the device opted into auto-reconnect. */
  private applyTerminatedStatus(status: SessionStatus, message?: string, code?: ErrorCode): void {
    const reconnecting = this.scheduleReconnect(status, code);
    this.session.end();
    this.stopResizeObserver();
    this.updateControls();
    this.userInitiated = false;
    if (reconnecting) {
      this.showReconnectOverlay();
      return;
    }
    this.overlay.show(() => overlayForStatus(status, message));
  }

  /** Neither a drop the user asked for nor a shell they exited is unexpected;
   * the budget turns down a failure a retry would only repeat (wrong
   * password, rejected host key: retrying would re-prompt and risk a lockout). */
  private scheduleReconnect(status: SessionStatus, code?: ErrorCode): boolean {
    if (this.userInitiated || status === "exited") {
      this.reconnect.reset();
      return false;
    }
    return this.reconnect.schedule(this.deviceAutoReconnect(), code);
  }

  /** Whether this pane's assigned device opted into auto-reconnect (Phase 5). */
  private deviceAutoReconnect(): boolean {
    return this.assignedDevice()?.autoReconnect ?? false;
  }

  private showReconnectOverlay(): void {
    this.setStatus("connecting");
    this.overlay.showReconnecting(this.reconnect.attempts);
  }

  /** Cancel a pending/active auto-reconnect — closing an attempt that is
   * already opening — and show a manual-retry overlay. */
  private cancelReconnect(): void {
    this.reconnect.reset();
    this.releaseSession();
    this.setStatus("disconnected");
    this.overlay.show(() => overlayForStatus("disconnected", t("pane.overlay.reconnectCancelled")));
  }

  /**
   * Let go of the current and any in-flight session: close them and stop
   * listening to their ids, so their late events can't touch whatever comes
   * next. `disconnect` is idempotent and a no-op for a session that already
   * ended (or one not spawned yet — `adoptSession` closes that one later).
   */
  private releaseSession(): void {
    const ids = this.session.release();
    this.stopResizeObserver();
    for (const id of ids) void disconnect(id);
    this.updateControls();
  }

  /** Hide the overlay entirely (return the pane to its idle empty state). */
  private hideOverlay(): void {
    this.overlay.hide();
    this.setStatus("idle");
  }

  /**
   * Re-render this pane's chrome in the current locale (Phase: i18n). Called on
   * a language change for every live pane: relabels the static buttons, rebuilds
   * the device dropdown (incl. the "no devices" placeholder), and re-renders
   * whatever overlay is currently displayed. The terminal itself is untouched.
   */
  retranslate(): void {
    relabelPane(this.root);
    this.searchBar.retranslate();
    this.deviceSelect.render(this.devices, this.deviceId);
    this.renderStatus();
    this.overlay.retranslate();
  }

  /** Moves keyboard focus into this pane's terminal (no-op if none yet). */
  focus(): void {
    this.terminal?.focus();
  }

  /**
   * True when a backend session exists — or is being opened — for this pane.
   * Used by the grid-shrink flow to decide whether dropping this pane needs a
   * confirmation (SPEC §7).
   */
  hasLiveSession(): boolean {
    return this.session.current !== null || this.connecting;
  }

  /** Whether the status chip reads "connected" (what the side menu counts). */
  showsConnected(): boolean {
    return this.paneStatus === "connected";
  }

  /**
   * True when this pane has a live, shell-ready session (connected, not merely
   * connecting). The grid uses it to decide which panes broadcast input reaches.
   */
  isConnected(): boolean {
    return this.session.isConnected();
  }

  /**
   * Write input to this pane's live session — the receiving end of the grid's
   * broadcast fan-out. A no-op for an idle, connecting, or errored pane.
   * Deliberately does NOT go through `terminal.onData`, so a broadcast never
   * re-triggers `onInput` (no loop).
   */
  sendInput(data: string): void {
    const sessionId = this.session.writableId();
    if (sessionId) this.write(sessionId, data);
  }

  private write(sessionId: string, data: string): void {
    this.input.push(() => writeStdin(sessionId, data));
  }

  /**
   * This pane's assigned device id (what a profile save records for this cell),
   * or `null` for an empty pane. Set when the user picks a device, connects, or
   * a profile load assigns one.
   */
  getDeviceId(): string | null {
    return this.deviceId === "" ? null : this.deviceId;
  }

  /**
   * Programmatically assign (or clear, with `null`) this pane's device, e.g.
   * when applying a loaded profile. Reflects the choice in the dropdown but does
   * NOT connect and does NOT fire `onChange` (the grid emits a single change
   * after a whole profile load to avoid per-pane dirty-dot churn).
   */
  assignDevice(deviceId: string | null): void {
    this.deviceId = deviceId;
    this.deviceSelect.select(deviceId);
    this.showEndpoint();
  }

  /**
   * Connect this pane's currently-assigned device, if any (used by profile
   * auto-connect). A no-op for an empty pane. Failures surface in this pane's
   * own error overlay (via `startSession`), giving the load flow per-pane
   * failure isolation without the caller needing to catch anything.
   */
  async connectAssigned(): Promise<void> {
    if (this.getDeviceId()) await this.startSession();
  }

  /** Re-fits the terminal to its container WITHOUT notifying the backend PTY. */
  fit(): void {
    this.fitAddon?.fit();
  }

  /**
   * Apply terminal appearance settings to this pane's live terminal (Phase 5).
   * A no-op if no terminal exists yet (a terminal created later reads the
   * current settings via `getTerminalSettings`). Re-fits and pushes the new size
   * to the PTY since a font change alters the cols/rows that fit.
   */
  applyTerminalSettings(settings: TerminalSettings): void {
    if (!this.terminal) return;
    applyTerminalOptions(this.terminal, settings);
    this.syncSize();
  }

  /** Fits and, if connected, pushes the resulting size to the backend PTY. */
  syncSize(): void {
    this.fitAddon?.fit();
    this.pushSize(this.session.resizableId());
  }

  /**
   * Toggles resize throttling. While throttled the internal `ResizeObserver`
   * still re-fits the terminal but skips `resize_pty`; the grid flips this on for
   * the duration of a splitter drag and calls `syncSize()` once on drag end.
   */
  setResizeThrottled(throttled: boolean): void {
    this.resizeThrottled = throttled;
  }

  private showEndpoint(): void {
    this.deviceSelect.showEndpoint(this.assignedDevice());
  }

  private stopResizeObserver(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  private teardownTerminal(): void {
    this.output?.stop();
    this.output = null;
    this.stopResizeObserver();
    this.searchBar.attach(null);
    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
  }

  /**
   * Full teardown: removes the status listener + terminal and closes any live
   * backend session. Called on app shutdown/hot reload and when the grid drops
   * this pane on a shrink (SPEC §7). `disconnect` is idempotent and a no-op for
   * an unknown session, so a double-teardown is safe.
   */
  dispose(): void {
    // Stop any pending auto-reconnect so its timer can't fire startSession()
    // after this pane is gone (would leak a session / touch a dead DOM).
    this.userInitiated = true;
    this.disposed = true;
    this.reconnect.reset();
    this.unlistenStatus?.();
    this.unlistenStatus = null;
    this.clipboard.dispose();
    this.closeCurrentSession();
    this.teardownTerminal();
    this.paneStatus = "idle";
    this.options.onStatusChange?.();
  }
}

function errorMessage(err: unknown): string {
  const message = (err as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" ? message : String(err);
}
