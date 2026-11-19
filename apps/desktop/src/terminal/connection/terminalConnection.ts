/**
 * A terminal pane's connection to its backend session. DOM-free: it owns the
 * session ids (adopting or closing a session that `connect()` returns late),
 * whether a drop was asked for, the auto-reconnect budget, and the input and
 * output streams. The pane renders `state()` on each `onChange`.
 */

import type { ErrorCode, SessionStatus } from "../../ipc";
import { InputQueue, type InputHealth } from "../inputQueue";
import { OutputReader } from "../outputReader";
import { errorCodeOf } from "../reconnect";
import { ReconnectBudget } from "../reconnectBudget";
import { logCloseFailed, logInputHealth, logReadTimeout, shellLabel } from "../pane/paneLog";
import { getErrorMessage } from "../../ui/errorMessage";
import { SessionSlot } from "./sessionSlot";
import type { SessionsPort } from "./sessionsPort";

export type ConnectionStatus = SessionStatus | "idle";

/** What the overlay over the terminal shows. */
export type Notice =
  | { kind: "hidden" }
  | { kind: "status"; status: SessionStatus; message?: string }
  | { kind: "reconnecting"; attempt: number }
  | { kind: "deviceGone" }
  | { kind: "reconnectCancelled" };

export interface ConnectionState {
  /** The status chip. */
  status: ConnectionStatus;
  inputHealth: InputHealth;
  /** A new object each time the overlay is to be redrawn. */
  notice: Notice;
  /** A session is open (not only opening). */
  open: boolean;
  /** A session is open, or one is being opened. */
  live: boolean;
  /** The device can't change: a session is open or opening. */
  locked: boolean;
  /** Input reaches the session. */
  connected: boolean;
}

/** The terminal a session's output goes to. */
export interface SessionTerminal {
  readonly cols: number;
  readonly rows: number;
  /** Resolves once the terminal has processed `bytes`. */
  write(bytes: Uint8Array): Promise<void>;
}

export interface ConnectionHost {
  /** The pane's assigned device: what a reconnect targets. */
  deviceId(): string | null;
  autoReconnectEnabled(): boolean;
  /** Names the connection in the diagnostic log. */
  deviceName(): string;
  recordTo(): string | undefined;
  /** A fresh terminal for a new attempt. */
  openTerminal(): SessionTerminal;
  /** An attempt targets this device. */
  onAttempt(deviceId: string): void;
  onError(message: string): void;
  onChange(): void;
}

export class TerminalConnection {
  private readonly session = new SessionSlot();
  private readonly reconnect: ReconnectBudget;
  /** An attempt runs across an `await connect()` that can take seconds: a
   * second one meanwhile would orphan the first one's session. */
  private connecting = false;
  /** The next drop was asked for (Disconnect, teardown): don't reconnect it. */
  private userInitiated = false;
  /** A connect resolving after `dispose()` must close its session. */
  private disposed = false;
  private status: ConnectionStatus = "idle";
  private inputHealth: InputHealth = "ok";
  private notice: Notice = { kind: "hidden" };
  private input = this.makeInputQueue();
  private output: OutputReader | null = null;
  private unlisten: (() => void) | null = null;

  constructor(
    private readonly port: SessionsPort,
    private readonly host: ConnectionHost,
  ) {
    this.reconnect = new ReconnectBudget(
      () => void this.runAttempt(() => this.beginRetry()),
      () => shellLabel(host.deviceName()),
    );
  }

  async listen(): Promise<void> {
    const unlisten = await this.port.onSessionStatus((event) => {
      if (this.session.isOwnerOf(event.sessionId)) this.applyStatus(event.status, event.message, event.code);
    });
    if (this.disposed) unlisten();
    else this.unlisten = unlisten;
  }

  state(): ConnectionState {
    return {
      status: this.status,
      inputHealth: this.inputHealth,
      notice: this.notice,
      open: this.session.current !== null,
      live: this.session.current !== null || this.connecting,
      locked: this.session.isBusy() || this.connecting,
      connected: this.session.isConnected(),
    };
  }

  currentSessionId(): string | null {
    return this.session.current;
  }

  /** The open and the opening session. */
  sessionIds(): string[] {
    return this.session.ids();
  }

  ownsSession(sessionId: string): boolean {
    return this.session.isOwnerOf(sessionId);
  }

  /** A manual connect to `deviceId` (none: only closes what is open). */
  connect(deviceId: string | null): Promise<void> {
    return this.runAttempt(() => this.beginManual(deviceId));
  }

  private async runAttempt(begin: () => string | null): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;
    try {
      await this.connectDevice(begin());
    } finally {
      this.connecting = false;
      this.emit();
    }
  }

  /** A manual connect supersedes a pending auto-reconnect: left armed, its
   * timer would start a second session. */
  private beginManual(deviceId: string | null): string | null {
    this.stopReconnecting();
    this.releaseSession();
    return deviceId;
  }

  /** A reconnect targets the assigned device only; with none left, it says so
   * instead of hanging. */
  private beginRetry(): string | null {
    this.releaseSession();
    const deviceId = this.host.deviceId();
    if (!deviceId) this.showDeviceGone();
    return deviceId;
  }

  private showDeviceGone(): void {
    this.stopReconnecting();
    this.notice = { kind: "deviceGone" };
  }

  private async connectDevice(deviceId: string | null): Promise<void> {
    if (!deviceId) return;
    this.beginAttempt();
    this.host.onAttempt(deviceId);
    const terminal = this.openTerminal();
    this.applyStatus("connecting");
    await this.establish(deviceId, terminal);
  }

  /** Any drop that follows is unexpected until the user disconnects. */
  private beginAttempt(): void {
    this.userInitiated = false;
  }

  /** The next drop was asked for: it must not reconnect. */
  private markUserDrop(): void {
    this.userInitiated = true;
    this.stopReconnecting();
  }

  /** Ends any reconnect sequence, cancelling a pending retry timer. */
  private stopReconnecting(): void {
    this.reconnect.reset();
  }

  /** A queue per terminal: a send stuck in an old session can't hold up the
   * next one's input. */
  private openTerminal(): SessionTerminal {
    this.stopOutput();
    const terminal = this.host.openTerminal();
    this.input = this.makeInputQueue();
    this.inputHealth = "ok";
    return terminal;
  }

  private makeInputQueue(): InputQueue {
    const queue = new InputQueue((health) => {
      if (queue === this.input) this.showInputHealth(health);
    });
    return queue;
  }

  private showInputHealth(health: InputHealth): void {
    logInputHealth(this.host.deviceName(), health);
    this.inputHealth = health;
    this.emit();
  }

  private async establish(deviceId: string, terminal: SessionTerminal): Promise<void> {
    const sessionId = this.port.newSessionId();
    this.session.open(sessionId);
    try {
      await this.port.connect(sessionId, deviceId, terminal.cols, terminal.rows, this.host.recordTo());
      if (this.adopt(sessionId)) this.readOutputInto(sessionId, terminal);
    } catch (err) {
      this.onConnectFailed(sessionId, err);
    }
  }

  private onConnectFailed(sessionId: string, err: unknown): void {
    // Disposed, or released (cancelled / replaced) while opening: nothing left
    // to report.
    if (this.disposed || !this.session.failOpen(sessionId)) return;
    const message = getErrorMessage(err);
    this.applyStatus("error", message, errorCodeOf(err));
    this.host.onError(message);
  }

  private readOutputInto(sessionId: string, terminal: SessionTerminal): void {
    this.stopOutput();
    const output = new OutputReader({
      read: (from) => this.port.readOutput(sessionId, from),
      write: (bytes) => terminal.write(bytes),
      onReadTimeout: (unanswered) => logReadTimeout(this.host.deviceName(), unanswered),
    });
    this.output = output;
    void output.run();
  }

  private stopOutput(): void {
    this.output?.stop();
    this.output = null;
  }

  /** Take a session `connect()` just opened, unless the connection let go of
   * it meanwhile (disposed, cancelled, replaced, or it already ended): then
   * close it (a no-op for a session that ended). */
  private adopt(sessionId: string): boolean {
    if (this.disposed || !this.session.adopt(sessionId)) {
      void this.closeSession(sessionId);
      return false;
    }
    this.emit();
    return true;
  }

  private applyStatus(status: SessionStatus, message?: string, code?: ErrorCode): void {
    this.status = status;
    this.statusHandlers[status](status, message, code);
    this.emit();
  }

  private readonly statusHandlers: Record<
    SessionStatus,
    (status: SessionStatus, message?: string, code?: ErrorCode) => void
  > = {
    connecting: (status, message) => this.applyConnecting(status, message),
    connected: (status, message) => this.applyConnected(status, message),
    disconnected: (status, message, code) => this.applyEnded(status, message, code),
    exited: (status, message, code) => this.applyEnded(status, message, code),
    error: (status, message, code) => this.applyEnded(status, message, code),
  };

  /** During an auto-reconnect the connecting frame keeps its context
   * (attempt N of M + Cancel). */
  private applyConnecting(status: SessionStatus, message?: string): void {
    if (this.reconnect.isInProgress()) this.showReconnecting();
    else this.notice = { kind: "status", status, message };
  }

  /** A successful connect ends any reconnect sequence. */
  private applyConnected(status: SessionStatus, message?: string): void {
    this.session.markConnected();
    this.stopReconnecting();
    this.notice = { kind: "status", status, message };
  }

  /** The session is over: input stops. Reconnects instead when the drop was
   * unexpected and the device opted in. */
  private applyEnded(status: SessionStatus, message?: string, code?: ErrorCode): void {
    const reconnecting = this.scheduleReconnect(status, code);
    this.session.end();
    if (reconnecting) this.showReconnecting();
    else this.notice = { kind: "status", status, message };
  }

  /** Neither a drop the user asked for nor a shell they exited is unexpected;
   * the budget turns down a failure a retry would only repeat. */
  private scheduleReconnect(status: SessionStatus, code?: ErrorCode): boolean {
    if (this.userInitiated || status === "exited") {
      this.stopReconnecting();
      return false;
    }
    return this.reconnect.schedule(this.host.autoReconnectEnabled(), code);
  }

  private showReconnecting(): void {
    this.status = "connecting";
    this.notice = { kind: "reconnecting", attempt: this.reconnect.attempts };
  }

  /** Close the session on the user's request: its drop is not reconnected. */
  async disconnect(): Promise<void> {
    this.markUserDrop();
    const sessionId = this.session.current;
    if (sessionId) await this.closeSession(sessionId);
  }

  /** Stop an auto-reconnect, closing an attempt still opening. */
  cancel(): void {
    this.releaseSession();
    this.showStopped("disconnected", { kind: "reconnectCancelled" });
  }

  /** The device is gone: no reconnect, and no session left open while the
   * pane reads idle. */
  abandon(): void {
    this.closeCurrentSession();
    this.showStopped("idle", { kind: "hidden" });
  }

  private showStopped(status: ConnectionStatus, notice: Notice): void {
    this.stopReconnecting();
    this.status = status;
    this.notice = notice;
    this.emit();
  }

  /** Close every session and stop listening; nothing reconnects afterwards. */
  dispose(): void {
    this.markUserDrop();
    this.disposed = true;
    this.unlisten?.();
    this.unlisten = null;
    this.closeCurrentSession();
    this.stopOutput();
    this.status = "idle";
    this.emit();
  }

  /** Let go of the current and any opening session, so their late events
   * can't touch what comes next. */
  private releaseSession(): void {
    for (const id of this.session.release()) void this.closeSession(id);
  }

  private closeCurrentSession(): void {
    const sessionId = this.session.dropCurrent();
    if (sessionId) void this.closeSession(sessionId);
  }

  /** Never rejects: a close that fails leaves only a log line. */
  private closeSession(sessionId: string): Promise<void> {
    return this.port.disconnect(sessionId).catch((err: unknown) => {
      logCloseFailed(this.host.deviceName(), getErrorMessage(err));
    });
  }

  /** Sends to the connected session; `false` when there is none. */
  send(data: string): boolean {
    const sessionId = this.session.writableId();
    if (!sessionId) return false;
    this.input.push(() => this.port.writeStdin(sessionId, data));
    return true;
  }

  /** Mouse reports that aren't UTF-8 (the legacy encoding). */
  sendBinary(data: string): void {
    const sessionId = this.session.writableId();
    if (sessionId) this.input.push(() => this.port.writeStdinBinary(sessionId, data));
  }

  /** Sends to the session connected now; a no-op once it ends, even after a
   * reconnect (a confirmed command must not reach another host). */
  senderForCurrentSession(): (data: string) => void {
    const sessionId = this.session.writableId();
    return (data) => {
      if (sessionId !== null && this.session.writableId() === sessionId) this.send(data);
    };
  }

  /** `connected` can arrive before `connect()` returns: resize that session. */
  resize(cols: number, rows: number): void {
    const sessionId = this.session.resizableId();
    if (sessionId) void this.port.resizePty(sessionId, cols, rows);
  }

  private emit(): void {
    this.host.onChange();
  }
}
