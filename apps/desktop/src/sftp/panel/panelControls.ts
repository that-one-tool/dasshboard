/** The Files panel's status line and which of its controls are enabled: the
 * browsing controls need a connected, idle panel; the picker only idle. */

import { t } from "../../i18n";
import { connectIcon, disconnectIcon } from "../../ui/icons";
import type { DirHistory } from "./dirHistory";
import type { PanelElements } from "./panelElements";
import type { PanelSession } from "./panelSession";

export class PanelControls {
  /** True while a connect/list/transfer is in flight (disables the toolbar). */
  private busy = false;

  constructor(
    private readonly els: () => PanelElements,
    private readonly session: PanelSession,
    private readonly history: DirHistory,
  ) {}

  setStatus(text: string): void {
    this.els().status.textContent = text;
  }

  isBusy(): boolean {
    return this.busy;
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.syncControls();
  }

  /** Enable the browsing controls (toolbar, path, filter, sort) only when
   * connected and idle; the device picker only needs idle. */
  syncControls(): void {
    const els = this.els();
    const off = this.busy || !this.session.isConnected();
    els.root.querySelectorAll<HTMLButtonElement>('.sftp-toolbar .btn, [data-action="sort"]').forEach((btn) => {
      btn.disabled = off;
    });
    els.path.readOnly = off;
    els.filter.disabled = off;
    els.deviceSelect.disabled = this.busy;
    if (!off) this.updateNavButtons();
  }

  /** Enable/disable Back and Forward per the history cursor (idle state only). */
  updateNavButtons(): void {
    const { back, forward } = this.els();
    back.disabled = !this.history.canGoBack();
    forward.disabled = !this.history.canGoForward();
  }

  /** Reflect connection state onto the indicator dot and the connect/disconnect
   * toggle (red + Disconnect when connected, green + Connect when not). */
  updateConnToggle(): void {
    const connected = this.session.isConnected();
    const { connDot, connToggle } = this.els();
    connDot.classList.toggle("connected", connected);
    renderConnToggle(connToggle, connected);
    connToggle.disabled = this.isToggleInert(connected);
    this.syncControls();
  }

  /** Mid-connect, or disconnected with no device chosen yet. */
  private isToggleInert(connected: boolean): boolean {
    return this.session.connecting || (!connected && !this.session.selectedDeviceId);
  }
}

function renderConnToggle(btn: HTMLButtonElement, connected: boolean): void {
  btn.classList.toggle("is-connected", connected);
  btn.classList.toggle("is-disconnected", !connected);
  btn.innerHTML = connected ? disconnectIcon : connectIcon;
  const label = connected ? t("sftp.disconnect") : t("sftp.connect");
  btn.title = label;
  btn.setAttribute("aria-label", label);
}
