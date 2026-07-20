/**
 * The single SSH terminal pane (SPEC §7, Phase 2). Device dropdown + Connect;
 * on connect it creates a real xterm.js terminal wired to the backend session:
 * keystrokes → `write_stdin`, the per-session `Channel` → `terminal.write`, and
 * a `ResizeObserver` → fit addon → `resize_pty`. Status overlays (connecting
 * spinner; error/disconnected + Retry) react to `session_status` events. Copy
 * on select; paste on Ctrl+Shift+V and right-click.
 *
 * This module is deliberately thin glue over the DOM/terminal; the testable
 * decisions (status → overlay) live in `overlay.ts`.
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  connect,
  disconnect,
  listDevices,
  newDataChannel,
  onSessionStatus,
  resizePty,
  writeStdin,
  type Device,
  type SessionStatus,
  type TerminalSettings,
} from "../ipc";
import { overlayForStatus } from "./overlay";
import { DEFAULT_TERMINAL_SETTINGS, xtermThemeFor } from "./terminalSettings";
import {
  MAX_RECONNECT_ATTEMPTS,
  canReconnect,
  reconnectDelayMs,
} from "./reconnect";
import { isMultilinePaste, pasteConfirmMessage } from "./paste";
import { confirm } from "../ui/confirm";

function requireEl<E extends Element>(root: ParentNode, selector: string): E {
  const el = root.querySelector<E>(selector);
  if (!el) throw new Error(`Expected element not found: ${selector}`);
  return el;
}

export interface TerminalPaneOptions {
  onError?: (message: string) => void;
  /**
   * Fired when this pane's saved-state (its assigned device) changes — i.e. the
   * user picks a device or connects one. The grid uses it to recompute the
   * profile dirty-state dot (Phase 4). Not fired for programmatic
   * `assignDevice()` during a profile load (the grid suppresses churn there).
   */
  onChange?: () => void;
  /**
   * Supplies the current terminal appearance settings (font, theme). Read when a
   * terminal is created so panes opened after a settings change use the new
   * values; live changes go through `applyTerminalSettings` (Phase 5).
   */
  getTerminalSettings?: () => TerminalSettings;
}

export class TerminalPane {
  private root: HTMLElement;
  private options: TerminalPaneOptions;
  private devices: Device[] = [];

  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private unlistenStatus: (() => void) | null = null;

  private sessionId: string | null = null;
  private deviceId: string | null = null;
  private connected = false;
  // While a splitter drag is in progress the grid throttles PTY resizes: the
  // terminal still re-fits visually on every layout change, but `resize_pty` is
  // deferred to drag end (see grid.ts) to avoid spamming the backend.
  private resizeThrottled = false;

  // Auto-reconnect (Phase 5). `userInitiated` marks a disconnect the user (or a
  // grid teardown) asked for, so it is NOT treated as an unexpected drop.
  private userInitiated = false;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;

  constructor(root: HTMLElement, options: TerminalPaneOptions = {}) {
    this.root = root;
    this.options = options;
  }

  async init(): Promise<void> {
    this.renderUI();
    this.unlistenStatus = await onSessionStatus((event) => {
      if (event.sessionId === this.sessionId) {
        this.applyStatus(event.status, event.message);
      }
    });
    await this.refreshDevices();
  }

  /** Reloads the device dropdown (call after devices are added/edited/deleted). */
  async refreshDevices(): Promise<void> {
    try {
      this.devices = await listDevices();
    } catch {
      this.devices = [];
    }
    // If the assigned device was deleted, drop the stale reference so it can't be
    // re-persisted into a profile on the next Save (referential integrity: the
    // backend already nulled it out of profiles.json, and getDeviceId() feeds the
    // profile snapshot). `onChange` lets the dirty-state dot recompute.
    if (
      this.deviceId &&
      this.deviceId !== "" &&
      !this.devices.some((d) => d.id === this.deviceId)
    ) {
      this.deviceId = null;
      // The device we were connected to / reconnecting toward is gone: abandon
      // any pending auto-reconnect (there's nothing to reconnect to) and drop
      // back to the idle empty-pane state rather than a stale "Reconnecting…".
      this.cancelReconnectTimer();
      this.reconnecting = false;
      this.reconnectAttempts = 0;
      this.userInitiated = false;
      this.hideOverlay();
      this.options.onChange?.();
    }
    const select = requireEl<HTMLSelectElement>(this.root, ".pane-device-select");
    const previous = this.deviceId ?? select.value;
    select.innerHTML = "";
    if (this.devices.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No devices — add one in the sidebar";
      opt.disabled = true;
      opt.selected = true;
      select.appendChild(opt);
    } else {
      for (const device of this.devices) {
        const opt = document.createElement("option");
        opt.value = device.id;
        opt.textContent = `${device.name} (${device.host}:${device.port})`;
        if (device.id === previous) opt.selected = true;
        select.appendChild(opt);
      }
    }
    this.updateControls();
  }

  private renderUI(): void {
    this.root.innerHTML = `
      <div class="pane">
        <div class="pane-header">
          <span class="pane-status-dot pane-status-idle" aria-hidden="true"></span>
          <select class="pane-device-select" aria-label="Device to connect"></select>
          <button type="button" class="btn btn-primary pane-connect">Connect</button>
          <button type="button" class="btn btn-secondary pane-disconnect" hidden>
            Disconnect
          </button>
        </div>
        <div class="pane-body">
          <div class="pane-terminal"></div>
          <div class="pane-overlay dialog-hidden" role="status">
            <div class="overlay-inner">
              <div class="overlay-spinner" hidden></div>
              <div class="overlay-title"></div>
              <div class="overlay-detail"></div>
              <button type="button" class="btn btn-primary overlay-retry" hidden>
                Retry
              </button>
              <button type="button" class="btn btn-secondary overlay-cancel" hidden>
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    requireEl<HTMLButtonElement>(this.root, ".pane-connect").addEventListener(
      "click",
      () => void this.startSession(),
    );
    requireEl<HTMLButtonElement>(this.root, ".pane-disconnect").addEventListener(
      "click",
      () => void this.disconnectSession(),
    );
    requireEl<HTMLButtonElement>(this.root, ".overlay-retry").addEventListener(
      "click",
      () => void this.manualRetry(),
    );
    requireEl<HTMLButtonElement>(this.root, ".overlay-cancel").addEventListener(
      "click",
      () => this.cancelReconnect(),
    );
    requireEl<HTMLSelectElement>(this.root, ".pane-device-select").addEventListener(
      "change",
      (e) => {
        const target = e.target;
        if (target instanceof HTMLSelectElement) {
          this.deviceId = target.value;
          this.updateHeaderTooltip();
          this.options.onChange?.();
        }
      },
    );
    // Right-click paste (SPEC §7). Attached ONCE here for the pane's lifetime,
    // not per-session: `.pane-terminal` is a persistent DOM node that survives
    // reconnects, so attaching this inside `startSession()` would accumulate a
    // duplicate listener on every Retry/reconnect and fire paste N times.
    // `pasteFromClipboard()` already self-guards on `this.connected`/`terminal`,
    // so it is safe to have live before the first connect.
    requireEl<HTMLElement>(this.root, ".pane-terminal").addEventListener(
      "contextmenu",
      (e) => {
        e.preventDefault();
        void this.pasteFromClipboard();
      },
    );
  }

  private updateControls(): void {
    const select = requireEl<HTMLSelectElement>(this.root, ".pane-device-select");
    const connectBtn = requireEl<HTMLButtonElement>(this.root, ".pane-connect");
    const disconnectBtn = requireEl<HTMLButtonElement>(
      this.root,
      ".pane-disconnect",
    );
    const busy = this.sessionId !== null;
    connectBtn.hidden = busy;
    connectBtn.disabled = this.devices.length === 0;
    disconnectBtn.hidden = !busy;
    select.disabled = busy;
    this.updateHeaderTooltip();
  }

  private setStatusDot(status: SessionStatus | "idle"): void {
    const dot = requireEl<HTMLElement>(this.root, ".pane-status-dot");
    dot.className = `pane-status-dot pane-status-${status}`;
  }

  private async startSession(fromReconnect = false): Promise<void> {
    const select = requireEl<HTMLSelectElement>(this.root, ".pane-device-select");
    // A reconnect must target the pane's *assigned* device only — never the
    // dropdown's fallback, which after a device deletion could be some other
    // device sitting at index 0. The `?? select.value` fallback is only for the
    // initial manual connect (user picked from the dropdown, no change event yet).
    const deviceId = fromReconnect ? this.deviceId : (this.deviceId ?? select.value);
    if (!deviceId) {
      if (fromReconnect) {
        // Nothing left to reconnect to (device removed) — stop, don't hang.
        this.reconnecting = false;
        this.reconnectAttempts = 0;
        this.renderOverlay(overlayForStatus("error", "Device is no longer available"));
      }
      return;
    }
    const deviceChanged = this.deviceId !== deviceId;
    this.deviceId = deviceId;
    // A fresh connect attempt: any drop that follows is unexpected (until the
    // user explicitly disconnects), so clear the user-initiated flag.
    this.userInitiated = false;
    // Connecting a device to a previously-empty pane changes the saved-state.
    if (deviceChanged) this.options.onChange?.();

    // Fresh terminal per connection (no stale scrollback from a prior session).
    this.teardownTerminal();
    const settings = this.options.getTerminalSettings?.() ?? DEFAULT_TERMINAL_SETTINGS;
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      theme: xtermThemeFor(settings.theme),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    const terminalEl = requireEl<HTMLElement>(this.root, ".pane-terminal");
    terminal.open(terminalEl);
    fitAddon.fit();

    terminal.onData((data) => {
      if (this.connected && this.sessionId) {
        void writeStdin(this.sessionId, data);
      }
    });
    // Copy on select (SPEC §7).
    terminal.onSelectionChange(() => {
      const selection = terminal.getSelection();
      if (selection) void writeClipboard(selection);
    });
    // Ctrl+Shift+V paste (SPEC §7).
    terminal.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey && e.code === "KeyV") {
        void this.pasteFromClipboard();
        return false;
      }
      return true;
    });
    // (Right-click paste is wired once in renderUI(), not here — see comment
    // there; attaching it per-session leaked a listener on every reconnect.)

    this.terminal = terminal;
    this.fitAddon = fitAddon;

    // Immediate feedback before the backend's own `connecting` event arrives.
    this.applyStatus("connecting");
    this.setStatusDot("connecting");

    const channel = newDataChannel();
    channel.onmessage = (buffer) => {
      this.terminal?.write(new Uint8Array(buffer));
    };

    try {
      const sessionId = await connect(
        deviceId,
        terminal.cols,
        terminal.rows,
        channel,
      );
      this.sessionId = sessionId;
      this.updateControls();
      this.observeResize();
    } catch (err) {
      const message = err instanceof Error ? err.message : errorMessage(err);
      this.applyStatus("error", message);
      this.options.onError?.(message);
    }
  }

  private observeResize(): void {
    const terminalEl = requireEl<HTMLElement>(this.root, ".pane-terminal");
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.fitAddon || !this.terminal) return;
      this.fitAddon.fit();
      if (!this.resizeThrottled && this.connected && this.sessionId) {
        void resizePty(this.sessionId, this.terminal.cols, this.terminal.rows);
      }
    });
    this.resizeObserver.observe(terminalEl);
  }

  private async disconnectSession(): Promise<void> {
    // A user-requested disconnect is expected — don't auto-reconnect from it.
    this.userInitiated = true;
    this.cancelReconnectTimer();
    this.reconnecting = false;
    this.reconnectAttempts = 0;
    if (this.sessionId) {
      await disconnect(this.sessionId);
    }
  }

  private applyStatus(status: SessionStatus, message?: string): void {
    this.setStatusDot(status);

    if (status === "connecting") {
      // During an auto-reconnect the connecting frame keeps the reconnect
      // context (attempt N of M + Cancel) rather than a bare "Connecting…".
      if (this.reconnecting) {
        this.renderReconnectOverlay();
      } else {
        this.renderOverlay(overlayForStatus(status, message));
      }
      return;
    }

    if (status === "connected") {
      this.connected = true;
      // A successful connect ends any reconnect sequence. Clear `userInitiated`
      // (a cancel-then-connect must not suppress reconnecting a *future* drop).
      this.reconnecting = false;
      this.reconnectAttempts = 0;
      this.userInitiated = false;
      this.cancelReconnectTimer();
      this.terminal?.focus();
      this.fitAddon?.fit();
      this.renderOverlay(overlayForStatus(status, message));
      return;
    }

    // disconnected | error: the session is over. Stop forwarding input and free
    // the frontend mirror; the terminal stays visible (frozen) under the overlay.
    this.connected = false;
    this.sessionId = null;
    this.stopResizeObserver();
    this.updateControls();

    const wasUserInitiated = this.userInitiated;
    this.userInitiated = false;

    // Unexpected drop + the device opted into auto-reconnect + attempts left ⇒
    // schedule another attempt with backoff instead of the normal error overlay.
    if (
      !wasUserInitiated &&
      canReconnect(this.deviceAutoReconnect(), this.reconnectAttempts)
    ) {
      this.scheduleReconnect();
      return;
    }

    this.reconnecting = false;
    this.reconnectAttempts = 0;
    this.renderOverlay(overlayForStatus(status, message));
  }

  /** Whether this pane's assigned device opted into auto-reconnect (Phase 5). */
  private deviceAutoReconnect(): boolean {
    return this.devices.find((d) => d.id === this.deviceId)?.autoReconnect ?? false;
  }

  /** Schedule the next backoff reconnect attempt (Phase 5). */
  private scheduleReconnect(): void {
    this.reconnecting = true;
    this.reconnectAttempts += 1;
    this.renderReconnectOverlay();
    this.cancelReconnectTimer();
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.startSession(true);
    }, reconnectDelayMs(this.reconnectAttempts));
  }

  /** Cancel a pending/active auto-reconnect and show a manual-retry overlay. */
  private cancelReconnect(): void {
    this.cancelReconnectTimer();
    this.reconnecting = false;
    this.reconnectAttempts = 0;
    // Mark this as user-initiated so that if a `connect()` was already in flight
    // when Cancel was clicked, its later failure is NOT treated as an unexpected
    // drop and does not silently re-enter auto-reconnect. A successful in-flight
    // connect clears this again (see the `connected` branch of applyStatus).
    this.userInitiated = true;
    this.renderOverlay(overlayForStatus("disconnected", "Auto-reconnect cancelled"));
  }

  private cancelReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Manual Retry: reset the reconnect budget and connect fresh. */
  private async manualRetry(): Promise<void> {
    this.cancelReconnectTimer();
    this.reconnecting = false;
    this.reconnectAttempts = 0;
    await this.startSession();
  }

  private renderReconnectOverlay(): void {
    this.setStatusDot("connecting");
    const overlay = requireEl<HTMLElement>(this.root, ".pane-overlay");
    const spinner = requireEl<HTMLElement>(this.root, ".overlay-spinner");
    const title = requireEl<HTMLElement>(this.root, ".overlay-title");
    const detail = requireEl<HTMLElement>(this.root, ".overlay-detail");
    const retry = requireEl<HTMLButtonElement>(this.root, ".overlay-retry");
    const cancel = requireEl<HTMLButtonElement>(this.root, ".overlay-cancel");

    overlay.classList.remove("dialog-hidden");
    overlay.classList.remove("overlay-error");
    spinner.hidden = false;
    title.textContent = "Reconnecting…";
    detail.textContent = `Attempt ${this.reconnectAttempts} of ${MAX_RECONNECT_ATTEMPTS}`;
    retry.hidden = true;
    cancel.hidden = false;
  }

  /** Hide the overlay entirely (return the pane to its idle empty state). */
  private hideOverlay(): void {
    const overlay = this.root.querySelector<HTMLElement>(".pane-overlay");
    overlay?.classList.add("dialog-hidden");
    this.setStatusDot("idle");
  }

  private renderOverlay(state: ReturnType<typeof overlayForStatus>): void {
    const overlay = requireEl<HTMLElement>(this.root, ".pane-overlay");
    const spinner = requireEl<HTMLElement>(this.root, ".overlay-spinner");
    const title = requireEl<HTMLElement>(this.root, ".overlay-title");
    const detail = requireEl<HTMLElement>(this.root, ".overlay-detail");
    const retry = requireEl<HTMLButtonElement>(this.root, ".overlay-retry");
    const cancel = requireEl<HTMLButtonElement>(this.root, ".overlay-cancel");

    overlay.classList.toggle("dialog-hidden", !state.visible);
    overlay.classList.toggle("overlay-error", state.variant === "error");
    spinner.hidden = !state.showSpinner;
    title.textContent = state.title;
    detail.textContent = state.detail;
    retry.hidden = !state.showRetry;
    cancel.hidden = true;
  }

  /** Moves keyboard focus into this pane's terminal (no-op if none yet). */
  focus(): void {
    this.terminal?.focus();
  }

  /**
   * True when a backend session exists for this pane. Used by the grid-shrink
   * flow to decide whether dropping this pane needs a confirmation (SPEC §7).
   */
  hasLiveSession(): boolean {
    return this.sessionId !== null;
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
    const select = this.root.querySelector<HTMLSelectElement>(".pane-device-select");
    if (select) select.value = deviceId ?? "";
    this.updateHeaderTooltip();
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
    const terminal = this.terminal;
    if (!terminal) return;
    terminal.options.fontSize = settings.fontSize;
    terminal.options.fontFamily = settings.fontFamily;
    terminal.options.theme = xtermThemeFor(settings.theme);
    this.syncSize();
  }

  /** Fits and, if connected, pushes the resulting size to the backend PTY. */
  syncSize(): void {
    if (!this.fitAddon || !this.terminal) return;
    this.fitAddon.fit();
    if (this.connected && this.sessionId) {
      void resizePty(this.sessionId, this.terminal.cols, this.terminal.rows);
    }
  }

  /**
   * Toggles resize throttling. While throttled the internal `ResizeObserver`
   * still re-fits the terminal but skips `resize_pty`; the grid flips this on for
   * the duration of a splitter drag and calls `syncSize()` once on drag end.
   */
  setResizeThrottled(throttled: boolean): void {
    this.resizeThrottled = throttled;
  }

  private async pasteFromClipboard(): Promise<void> {
    if (!this.connected || !this.terminal) return;
    const text = await readClipboard();
    if (!text) return;
    // Multi-line paste can run several commands at once — confirm first (Phase 5).
    if (isMultilinePaste(text)) {
      const ok = await confirm(pasteConfirmMessage(text), {
        title: "Paste multiple lines?",
        confirmLabel: "Paste",
      });
      if (!ok) return;
    }
    // `connected`/`terminal` may have changed while the dialog was open.
    if (this.connected && this.terminal) this.terminal.paste(text);
  }

  /** Show the assigned device's host:port as a tooltip on the pane header. */
  private updateHeaderTooltip(): void {
    const header = this.root.querySelector<HTMLElement>(".pane-header");
    if (!header) return;
    const device = this.devices.find((d) => d.id === this.deviceId);
    if (device) header.title = `${device.host}:${device.port}`;
    else header.removeAttribute("title");
  }

  private stopResizeObserver(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  private teardownTerminal(): void {
    this.stopResizeObserver();
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
    this.cancelReconnectTimer();
    this.reconnecting = false;
    this.unlistenStatus?.();
    this.unlistenStatus = null;
    if (this.sessionId) {
      void disconnect(this.sessionId);
      this.sessionId = null;
    }
    this.teardownTerminal();
  }
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard unavailable — ignore (copy-on-select is best effort) */
  }
}

async function readClipboard(): Promise<string> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}
