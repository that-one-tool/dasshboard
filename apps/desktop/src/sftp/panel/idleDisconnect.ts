/** Disconnects a collapsed, connected panel after the idle timeout from
 * settings (`0` = off). An open edit keeps the connection: its saves still
 * need uploading. */

import { t } from "../../i18n";
import { IdleTimer } from "./idleTimer";
import type { PanelControls } from "./panelControls";
import type { PanelSession } from "./panelSession";

export interface IdleDeps {
  session: PanelSession;
  controls: PanelControls;
  /** The live idle-timeout setting, in minutes. */
  timeoutMinutes: () => number;
  hasEdits: (deviceId: string) => boolean;
  disconnect: () => Promise<void>;
  showDisconnected: () => void;
}

export class IdleDisconnect {
  private readonly timer = new IdleTimer(() => void this.onTimeout());

  constructor(private readonly deps: IdleDeps) {}

  /** Start the countdown for a connected panel without open edits. */
  arm(): void {
    this.timer.clear();
    const deviceId = this.deps.session.activeDeviceId;
    if (deviceId === null || this.deps.hasEdits(deviceId)) return;
    this.timer.arm(this.deps.timeoutMinutes());
  }

  clear(): void {
    this.timer.clear();
  }

  private async onTimeout(): Promise<void> {
    const { session, controls } = this.deps;
    if (!session.isConnected()) return;
    await this.deps.disconnect();
    session.markIdleDisconnected();
    controls.setStatus(t("sftp.idleDisconnected"));
    this.deps.showDisconnected();
    controls.updateConnToggle();
  }
}
