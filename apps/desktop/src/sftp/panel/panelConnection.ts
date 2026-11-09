/**
 * The Files panel's connection lifecycle: one live browse at a time.
 * Selecting a device disconnects the previous one, connects and lists its
 * start directory; disconnecting drops its transfers and edits. A connect
 * that resolves after the user moved on is stale and closed again.
 */

import { sftpConnect, sftpConnectedDevices, sftpDisconnect } from "../../ipc";
import { t, tp } from "../../i18n";
import { confirm } from "../../ui/confirm";
import type { DirHistory } from "./dirHistory";
import { LatestAttempt } from "./latestAttempt";
import type { PanelControls } from "./panelControls";
import type { PanelFeedback } from "./panelFeedback";
import type { PanelSession } from "./panelSession";

export interface ConnectionDeps {
  session: PanelSession;
  controls: PanelControls;
  history: DirHistory;
  feedback: PanelFeedback;
  /** Saved changes not uploaded yet, of the device's edits. */
  unsyncedEdits: (deviceId: string) => number;
  /** The connection just opened: load what belongs to it and list `startDir`. */
  onConnected: (deviceId: string, startDir: string) => Promise<void>;
  /** The connection is going away: drop what belonged to it (`null`: none). */
  onReleased: (deviceId: string | null) => void;
  showDisconnected: () => void;
  syncPicker: () => void;
  clearIdle: () => void;
  persist: () => void;
}

export class PanelConnection {
  /** A connect that resolves after the user closed/disconnected is stale. */
  private readonly attempts = new LatestAttempt();

  constructor(private readonly deps: ConnectionDeps) {}

  /** Connect the panel to `deviceId` (unless it shows it already),
   * disconnecting whatever it was showing. */
  async select(deviceId: string): Promise<void> {
    if (!this.deps.session.isConnectedTo(deviceId)) await this.switchTo(deviceId);
  }

  /** The header connect/disconnect toggle: disconnect when connected, otherwise
   * connect the selected device. */
  toggle(): void {
    const { session } = this.deps;
    if (session.connecting) return;
    if (session.isConnected()) void this.confirmThenDisconnect();
    else this.reconnect();
  }

  /** Whether closing the active connection may end its edits: true unless some
   * have saved changes not uploaded and the user declines. */
  async confirmEndEdits(): Promise<boolean> {
    const deviceId = this.deps.session.activeDeviceId;
    const count = deviceId ? this.deps.unsyncedEdits(deviceId) : 0;
    return count === 0 || confirm(tp("sftp.edit.disconnectConfirm", count));
  }

  /** Drop the connection but keep the panel open, showing the disconnected
   * state (the green toggle then offers connect/reconnect). */
  async disconnect(): Promise<void> {
    this.deps.clearIdle();
    this.deps.session.clearIdleDisconnected();
    await this.disconnectActive();
    this.deps.controls.setStatus("");
    this.deps.showDisconnected();
    this.deps.controls.updateConnToggle();
  }

  /** Disconnect the live connection (if any) without touching panel visibility.
   * Idempotent and best-effort. */
  async disconnectActive(): Promise<void> {
    const { session } = this.deps;
    const deviceId = session.activeDeviceId;
    session.markDisconnected();
    this.attempts.invalidate(); // a connect still in flight is now stale
    session.stopConnecting();
    this.deps.controls.setBusy(false); // …and will never clear `busy` itself
    this.deps.onReleased(deviceId);
    if (deviceId) await closeQuietly(deviceId);
  }

  /**
   * Drop to the disconnected state if the backend no longer holds this panel's
   * connection — e.g. an update install closed every session and then failed.
   * A failed lookup keeps the current state.
   */
  async resync(): Promise<void> {
    const deviceId = this.deps.session.activeDeviceId;
    if (!deviceId) return;
    const live = await sftpConnectedDevices().catch(() => [deviceId]);
    if (this.isLost(deviceId, live)) await this.disconnect();
  }

  /** The user may have switched devices while the lookup was in flight. */
  private isLost(deviceId: string, live: string[]): boolean {
    return this.deps.session.isConnectedTo(deviceId) && !live.includes(deviceId);
  }

  /** Connect the selected device again (after an idle/explicit disconnect). */
  private reconnect(): void {
    const deviceId = this.deps.session.selectedDeviceId;
    if (deviceId) void this.switchTo(deviceId);
  }

  private async switchTo(deviceId: string): Promise<void> {
    if (await this.leaveOther(deviceId)) await this.connect(deviceId);
  }

  /** The user's Disconnect: ask first when edited files have changes not
   * uploaded (disconnecting ends the edits). */
  private async confirmThenDisconnect(): Promise<void> {
    if (await this.confirmEndEdits()) await this.disconnect();
  }

  /** Disconnect another device first; `false` when the user keeps it. */
  private async leaveOther(deviceId: string): Promise<boolean> {
    if (!this.showsOther(deviceId)) return true;
    if (!(await this.confirmEndEdits())) return this.keepCurrent();
    await this.disconnectActive();
    return true;
  }

  private showsOther(deviceId: string): boolean {
    const active = this.deps.session.activeDeviceId;
    return active !== null && active !== deviceId;
  }

  /** Put the picker back on the device kept. */
  private keepCurrent(): false {
    this.deps.syncPicker();
    return false;
  }

  private async connect(deviceId: string): Promise<void> {
    this.beginConnect(deviceId);
    const attempt = this.attempts.begin();
    this.deps.session.startConnecting();
    this.deps.controls.setBusy(true);
    try {
      // A first-contact host key raises the global host-key dialog; on accept
      // the connect proceeds and resolves here.
      await this.openIfCurrent(attempt, deviceId, await sftpConnect(deviceId));
    } catch (err) {
      this.failConnect(attempt, err);
    } finally {
      if (this.attempts.isCurrent(attempt)) this.finishConnect();
    }
  }

  private beginConnect(deviceId: string): void {
    this.deps.session.pickDevice(deviceId);
    this.deps.syncPicker();
    this.deps.session.clearIdleDisconnected();
    this.deps.history.reset();
    this.deps.controls.setStatus(t("sftp.connecting"));
  }

  private async openIfCurrent(attempt: number, deviceId: string, startDir: string): Promise<void> {
    if (!this.attempts.isCurrent(attempt)) return this.dropStale(deviceId);
    this.deps.session.markConnected(deviceId);
    this.deps.controls.updateConnToggle();
    await this.deps.onConnected(deviceId, startDir);
  }

  /** A superseded attempt (the user moved on) must not touch the newer one. */
  private failConnect(attempt: number, err: unknown): void {
    if (!this.attempts.isCurrent(attempt)) return;
    this.deps.session.markDisconnected();
    this.deps.controls.setStatus("");
    this.deps.feedback.notify(err);
    this.deps.showDisconnected();
    this.deps.controls.updateConnToggle();
  }

  /** Settle the panel after the current connect attempt ends either way. */
  private finishConnect(): void {
    this.deps.session.stopConnecting();
    this.deps.controls.setBusy(false);
    this.deps.controls.updateConnToggle();
    this.deps.persist(); // remember the (now-)selected device
  }

  /** Close a connection that finished opening after the user moved on (closed
   * the panel mid-connect), unless it is the one now on screen. */
  private dropStale(deviceId: string): void {
    if (this.deps.session.isConnectedTo(deviceId)) return;
    void sftpDisconnect(deviceId).catch(() => {});
  }
}

/** Best-effort — the connection is torn down backend-side regardless. */
async function closeQuietly(deviceId: string): Promise<void> {
  try {
    await sftpDisconnect(deviceId);
  } catch {
    // Nothing to do.
  }
}
