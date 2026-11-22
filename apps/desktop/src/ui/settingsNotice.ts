/** "Settings changed — reconnect to apply" with a Reconnect button: shown
 * over a live connection whose device's connection settings were edited, as
 * they only apply on the next connect. An edit made while connecting waits
 * (`markPending`) until the connection opens: that attempt may have read the
 * old settings. */

import { t } from "../i18n";

export class SettingsNotice {
  readonly element: HTMLElement;
  private readonly text: HTMLElement;
  private readonly button: HTMLButtonElement;
  /** The device edited, shown or still held: the only one Reconnect targets. */
  private deviceId: string | null = null;

  constructor(private readonly onReconnect: (deviceId: string) => void) {
    this.element = document.createElement("div");
    this.element.className = "settings-notice";
    this.element.setAttribute("role", "status");
    this.element.hidden = true;
    this.text = document.createElement("span");
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "btn btn-small btn-primary";
    this.button.addEventListener("click", () => this.reconnect());
    this.element.append(this.text, this.button);
    this.retranslate();
  }

  show(deviceId: string): void {
    this.deviceId = deviceId;
    this.element.hidden = false;
  }

  /** Clears a pending edit too: a new attempt reads the current settings. */
  hide(): void {
    this.deviceId = null;
    this.element.hidden = true;
  }

  markPending(deviceId: string): void {
    this.deviceId = deviceId;
  }

  /** The connection opened: show an edit made while it was connecting. */
  showPending(): void {
    if (this.deviceId) this.show(this.deviceId);
  }

  isShown(): boolean {
    return !this.element.hidden;
  }

  private reconnect(): void {
    if (this.deviceId) this.onReconnect(this.deviceId);
  }

  retranslate(): void {
    this.text.textContent = t("settingsNotice.text");
    this.button.textContent = t("settingsNotice.reconnect");
  }
}
