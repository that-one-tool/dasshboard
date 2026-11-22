/**
 * The single SSH terminal pane (SPEC §7, Phase 2). Device dropdown + Connect;
 * on connect it creates a real xterm.js terminal wired to the backend session:
 * keystrokes → `write_stdin`, the session's output (`read_output`, pulled by an
 * `OutputReader`) → `terminal.write`, and
 * a `ResizeObserver` → fit addon → `resize_pty`. Status overlays (connecting
 * spinner; error/disconnected + Retry) react to `session_status` events.
 *
 * This class renders and wires; the session, its reconnects and its input and
 * output streams are `connection/terminalConnection.ts`. Its other parts live
 * in `pane/` (markup, overlay, device dropdown, clipboard, terminal factory,
 * output recording).
 */

import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { openUrl } from "@tauri-apps/plugin-opener";
import { saveTextFile, type Device, type TerminalSettings } from "../ipc";
import type { DeviceCatalog, DeviceChange } from "../devices/deviceCatalog";
import { SettingsNotice } from "../ui/settingsNotice";
import { isTerminalReply } from "./terminalReplies";
import type { InputHealth } from "./inputQueue";
import { DEFAULT_TERMINAL_SETTINGS } from "./terminalSettings";
import {
  TerminalConnection,
  type ConnectionHost,
  type ConnectionState,
  type ConnectionStatus,
  type Notice,
  type SessionTerminal,
} from "./connection/terminalConnection";
import { ipcSessionsPort } from "./connection/sessionsPort";
import { isPasteShortcut } from "./paste";
import { linkHandlers } from "./links";
import { TerminalSearchBar, isFindShortcut } from "./searchBar";
import { bufferText, outputFileName } from "./scrollbackText";
import { paneMarkup, relabelPane } from "./pane/paneTemplate";
import { PaneOverlay } from "./pane/paneOverlay";
import { DeviceSelect } from "./pane/deviceSelect";
import { PaneClipboard } from "./pane/paneClipboard";
import { PaneRecording } from "./pane/paneRecording";
import { applyTerminalOptions, makeTerminal } from "./pane/terminalFactory";
import { pickTextSavePath } from "../ui/fileDialog";
import { showToast } from "../ui/toast";
import { requireEl } from "../ui/dom";
import { t } from "../i18n";
import type { MessageKey } from "../i18n/en";
import { deviceEndpoint } from "../devices/deviceEndpoint";
import { getErrorMessage } from "../ui/errorMessage";

// Re-exported so callers already importing them from this module keep working.
export { deviceEndpoint };
export { deviceOptionLabel } from "./pane/deviceSelect";

export interface TerminalPaneOptions {
  /** The window's device list: the dropdown shows it, and its changes reach
   * the pane (a deletion abandons the session, a settings edit offers a
   * reconnect). Read at each use, so a pane built mid-edit is never stale. */
  catalog: DeviceCatalog;
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

/** What the chip shows: the status, or a connected session whose input is late
 * (`not-responding`) or stopped for good (`input-lost`). */
type ShownStatus = ConnectionStatus | "not-responding" | "input-lost";

const STATUS_LABEL_KEYS: Record<ShownStatus, MessageKey> = {
  "not-responding": "pane.status.notResponding",
  "input-lost": "pane.status.inputLost",
  idle: "pane.status.idle",
  connecting: "pane.status.connecting",
  connected: "pane.status.connected",
  disconnected: "pane.status.disconnected",
  exited: "pane.status.exited",
  error: "pane.status.error",
};

const STATUS_HINT_KEYS: Partial<Record<ShownStatus, MessageKey>> = {
  "not-responding": "pane.status.notRespondingHint",
  "input-lost": "pane.status.inputLostHint",
};

const INPUT_HEALTH_STATUS: Partial<Record<InputHealth, ShownStatus>> = {
  stalled: "not-responding",
  lost: "input-lost",
};

export class TerminalPane {
  private readonly root: HTMLElement;
  private readonly options: TerminalPaneOptions;

  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly overlay: PaneOverlay;
  private readonly deviceSelect: DeviceSelect;
  private readonly searchBar: TerminalSearchBar;
  private readonly clipboard: PaneClipboard;
  private readonly recording: PaneRecording;
  private readonly connection: TerminalConnection;
  private readonly settingsNotice = new SettingsNotice((deviceId) => void this.connection.connect(deviceId));
  private readonly unsubscribeDevices: () => void;
  /** The overlay drawn last: redrawn only when the connection asks again. */
  private shownNotice: Notice;
  private shownStatus: ConnectionStatus = "idle";
  /** The pane's own keys inside the terminal, each with what it does. */
  private readonly terminalKeys: Array<[(e: KeyboardEvent) => boolean, () => void]> = [
    // Ctrl+Shift+V paste (SPEC §7).
    [isPasteShortcut, () => this.clipboard.pasteFromShortcut()],
    [isFindShortcut, () => this.searchBar.open()],
  ];

  private deviceId: string | null = null;
  // While a splitter drag is in progress the grid throttles PTY resizes: the
  // terminal still re-fits visually on every layout change, but `resize_pty` is
  // deferred to drag end (see grid.ts) to avoid spamming the backend.
  private resizeThrottled = false;

  constructor(root: HTMLElement, options: TerminalPaneOptions) {
    this.root = root;
    this.options = options;
    root.innerHTML = paneMarkup();
    this.overlay = new PaneOverlay(root);
    this.deviceSelect = new DeviceSelect(root, (deviceId) => this.pickDevice(deviceId));
    this.searchBar = this.makeSearchBar();
    this.clipboard = this.makeClipboard();
    this.recording = this.makeRecording();
    this.connection = new TerminalConnection(ipcSessionsPort, this.connectionHost());
    this.shownNotice = this.connection.state().notice;
    requireEl<HTMLElement>(root, ".pane-body").append(this.settingsNotice.element);
    this.renderStatus();
    this.wireButtons();
    this.renderDevices();
    this.unsubscribeDevices = options.catalog.subscribe((change) => this.onDevicesChanged(change));
  }

  async init(): Promise<void> {
    await this.connection.listen();
    await this.recording.listen();
  }

  private connectionHost(): ConnectionHost {
    return {
      deviceId: () => this.deviceId,
      autoReconnectEnabled: () => this.assignedDevice()?.autoReconnect ?? false,
      deviceName: () => this.assignedDeviceName(),
      recordTo: () => this.recording.recordTo(),
      openTerminal: () => this.createSessionTerminal(),
      onAttempt: (deviceId) => this.claimDevice(deviceId),
      onError: (message) => this.options.onError?.(message),
      onChange: () => this.render(),
    };
  }

  /** The catalog only changes on a successful load: a failed one keeps its
   * list, so a transient IPC error never reads as "every device deleted". */
  private onDevicesChanged(change: DeviceChange): void {
    if (this.deviceId) this.applyToAssigned(this.deviceId, change);
    this.renderDevices();
  }

  private applyToAssigned(deviceId: string, { changedIds }: DeviceChange): void {
    if (this.assignedDevice() === undefined) return this.dropDeletedDevice();
    if (changedIds.includes(deviceId)) this.showSettingsChanged(deviceId);
  }

  private renderDevices(): void {
    this.deviceSelect.render(this.devices(), this.deviceId);
    this.updateControls();
  }

  /** Drop the stale reference so it can't be re-persisted into a profile on the
   * next Save (the backend already nulled it out of profiles.json, and
   * getDeviceId() feeds the profile snapshot). `onChange` lets the dirty-state
   * dot recompute. */
  private dropDeletedDevice(): void {
    this.deviceId = null;
    this.settingsNotice.hide();
    // Nothing to reconnect to; a session left open would make the idle pane lie.
    this.connection.abandon();
    this.options.onChange?.();
  }

  /** The settings apply on the next connect: offer one over a connected
   * session, or once a connecting one is connected. */
  private showSettingsChanged(deviceId: string): void {
    const { connected, live } = this.connection.state();
    if (connected) return this.settingsNotice.show(deviceId);
    if (live) this.settingsNotice.markPending(deviceId);
  }

  private devices(): Device[] {
    return this.options.catalog.list();
  }

  private assignedDevice(): Device | undefined {
    return this.deviceId ? this.options.catalog.get(this.deviceId) : undefined;
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
      canPaste: () => this.connection.state().connected && this.terminal !== null,
      paste: (text) => this.terminal?.paste(text),
    });
  }

  private makeRecording(): PaneRecording {
    return new PaneRecording(this.root, {
      sessionId: () => this.connection.currentSessionId(),
      sessionIds: () => this.connection.sessionIds(),
      ownsSession: (sessionId) => this.connection.ownsSession(sessionId),
      deviceName: () => this.assignedDeviceName(),
      onError: (message) => this.options.onError?.(message),
    });
  }

  private wireButtons(): void {
    const actions: Array<[string, () => void]> = [
      [".pane-connect", () => void this.startSession()],
      [".pane-disconnect", () => void this.connection.disconnect()],
      [".pane-find", () => this.searchBar.open()],
      [".pane-save-output", () => void this.saveOutput()],
      [".overlay-retry", () => void this.startSession()],
      [".overlay-cancel", () => this.connection.cancel()],
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

  /** The initial manual connect may use the dropdown's own choice (user
   * picked from the dropdown, no change event yet). */
  private startSession(): Promise<void> {
    return this.connection.connect(this.deviceId ?? this.deviceSelect.value());
  }

  /** Records the target device as this pane's assignment. */
  private claimDevice(deviceId: string): void {
    // A new attempt reads the device's current settings.
    this.settingsNotice.hide();
    const deviceChanged = this.deviceId !== deviceId;
    this.deviceId = deviceId;
    // Connecting a device to a previously-empty pane changes the saved-state.
    if (deviceChanged) this.options.onChange?.();
  }

  private render(): void {
    const state = this.connection.state();
    this.renderStatus();
    this.updateControls();
    this.syncResizeObserver(state.open);
    this.renderSettingsNotice(state);
    this.renderNotice(state.notice);
    this.onStatusShown(state.status);
    this.options.onStatusChange?.();
  }

  private renderSettingsNotice({ connected, live }: ConnectionState): void {
    if (!live) return this.settingsNotice.hide();
    if (connected) this.settingsNotice.showPending();
  }

  private renderNotice(notice: Notice): void {
    if (notice === this.shownNotice) return;
    this.shownNotice = notice;
    this.overlay.showNotice(notice);
  }

  private onStatusShown(status: ConnectionStatus): void {
    const connectedNow = status === "connected" && this.shownStatus !== "connected";
    this.shownStatus = status;
    if (connectedNow) this.onConnected();
  }

  /** Pushes the size: the backend drops resizes sent while connecting (e.g.
   * the startup layout settling). */
  private onConnected(): void {
    this.terminal?.focus();
    this.syncSize();
  }

  private updateControls(): void {
    const { open, locked } = this.connection.state();
    const connectBtn = requireEl<HTMLButtonElement>(this.root, ".pane-connect");
    connectBtn.hidden = open;
    connectBtn.disabled = this.devices().length === 0;
    requireEl<HTMLButtonElement>(this.root, ".pane-disconnect").hidden = !open;
    // The device can't change while a session is open or still opening.
    this.deviceSelect.setLocked(locked);
    // An ended session's terminal stays readable, so these outlive it.
    requireEl<HTMLButtonElement>(this.root, ".pane-find").disabled = !this.terminal;
    requireEl<HTMLButtonElement>(this.root, ".pane-save-output").disabled = !this.terminal;
    this.recording.updateControls();
    this.showEndpoint();
  }

  private renderStatus(): void {
    const chip = requireEl<HTMLElement>(this.root, ".pane-status");
    const shown = this.chipStatus();
    chip.className = `pane-status pane-status-${shown}`;
    const label = t(STATUS_LABEL_KEYS[shown]);
    requireEl<HTMLElement>(chip, ".pane-status-label").textContent = label;
    const hintKey = STATUS_HINT_KEYS[shown];
    chip.title = hintKey ? t(hintKey) : label;
  }

  private chipStatus(): ShownStatus {
    const { status, inputHealth } = this.connection.state();
    const inputStatus = INPUT_HEALTH_STATUS[inputHealth];
    return inputStatus && status === "connected" ? inputStatus : status;
  }

  /** Builds a fresh xterm.js terminal for a new connection attempt (no stale
   * scrollback from a prior session). */
  private createSessionTerminal(): SessionTerminal {
    this.teardownTerminal();
    const terminalEl = requireEl<HTMLElement>(this.root, ".pane-terminal");
    const links = linkHandlers(terminalEl, openUrl, (message) => this.options.onError?.(message));
    const { terminal, fitAddon, searchAddon } = makeTerminal(terminalEl, this.currentSettings(), links);
    this.wireTerminalInput(terminal);
    this.terminal = terminal;
    this.fitAddon = fitAddon;
    this.searchBar.attach(searchAddon);
    return this.sessionTerminal(terminal);
  }

  private sessionTerminal(terminal: Terminal): SessionTerminal {
    return {
      get cols() {
        return terminal.cols;
      },
      get rows() {
        return terminal.rows;
      },
      write: (bytes) => this.writeOutput(terminal, bytes),
    };
  }

  private wireTerminalInput(terminal: Terminal): void {
    terminal.onData((data) => this.onTypedData(data));
    // Mouse reports that aren't UTF-8 (the legacy encoding): never mirrored.
    terminal.onBinary((data) => this.connection.sendBinary(data));
    terminal.attachCustomKeyEventHandler((e) => this.onTerminalKey(e));
  }

  private onTypedData(data: string): void {
    if (this.connection.send(data)) this.mirrorInput(data);
  }

  /** Lets the grid mirror what the user typed into other panes (broadcast
   * mode) — never the terminal's own query replies or mouse reports. */
  private mirrorInput(data: string): void {
    if (!isTerminalReply(data)) this.options.onInput?.(data);
  }

  /** Resolves once xterm has processed `bytes` — only into the terminal the
   * session was opened with, never a later one. */
  private writeOutput(terminal: Terminal, bytes: Uint8Array): Promise<void> {
    if (this.terminal !== terminal) return Promise.resolve();
    return new Promise((resolve) => terminal.write(bytes, resolve));
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
      this.options.onError?.(getErrorMessage(err));
    }
  }

  private assignedDeviceName(): string {
    return this.assignedDevice()?.name ?? "";
  }

  /** Watches the layout while a session is open. */
  private syncResizeObserver(open: boolean): void {
    if (!open) this.stopResizeObserver();
    else if (!this.resizeObserver) this.observeResize();
  }

  private observeResize(): void {
    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(requireEl<HTMLElement>(this.root, ".pane-terminal"));
  }

  private onResize(): void {
    this.fitAddon?.fit();
    if (!this.resizeThrottled) this.pushSize();
  }

  private pushSize(): void {
    if (this.terminal) this.connection.resize(this.terminal.cols, this.terminal.rows);
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
    this.deviceSelect.render(this.devices(), this.deviceId);
    this.renderStatus();
    this.recording.render();
    this.overlay.retranslate();
    this.settingsNotice.retranslate();
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
    return this.connection.state().live;
  }

  /** Whether the status chip reads "connected" (what the side menu counts). */
  showsConnected(): boolean {
    return this.connection.state().status === "connected";
  }

  /**
   * True when this pane has a live, shell-ready session (connected, not merely
   * connecting). The grid uses it to decide which panes broadcast input reaches.
   */
  isConnected(): boolean {
    return this.connection.state().connected;
  }

  /**
   * Write input to this pane's live session — the receiving end of the grid's
   * broadcast fan-out. A no-op for an idle, connecting, or errored pane.
   * Deliberately does NOT go through `terminal.onData`, so a broadcast never
   * re-triggers `onInput` (no loop).
   */
  sendInput(data: string): void {
    this.connection.send(data);
  }

  /**
   * This pane's assigned device id (what a profile save records for this cell),
   * or `null` for an empty pane. Set when the user picks a device, connects, or
   * a profile load assigns one.
   */
  getDeviceId(): string | null {
    return this.deviceId === "" ? null : this.deviceId;
  }

  /** Sends to the session live now; a no-op once it ends, even if the pane
   * reconnects meanwhile (a confirmed command must not reach another host). */
  makeSessionSender(): (data: string) => void {
    return this.connection.senderForCurrentSession();
  }

  /** The assigned device's name, blank for an empty pane. */
  getDeviceName(): string {
    return this.assignedDevice()?.name ?? "";
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
    this.pushSize();
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
    this.stopResizeObserver();
    this.searchBar.attach(null);
    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
  }

  /**
   * Full teardown: closes any live backend session (no reconnect after it) and
   * removes the terminal. Called on app shutdown/hot reload and when the grid
   * drops this pane on a shrink (SPEC §7). Safe to call twice.
   */
  dispose(): void {
    this.unsubscribeDevices();
    this.clipboard.dispose();
    this.recording.dispose();
    this.connection.dispose();
    this.teardownTerminal();
  }
}

