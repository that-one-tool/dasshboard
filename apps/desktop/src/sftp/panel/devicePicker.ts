/** The panel header's device `<select>`: the saved SSH devices, pointing at
 * the connected (or else picked) one. */

import type { Device, SshDevice } from "../../ipc";
import { t } from "../../i18n";
import type { PanelElements } from "./panelElements";
import type { PanelSession } from "./panelSession";

/** The SSH devices — the only ones that can be browsed over SFTP. */
export function browsableDevices(devices: Device[]): SshDevice[] {
  return devices.filter((d): d is SshDevice => d.kind === "ssh");
}

export class DevicePicker {
  private devices: Device[] = [];

  constructor(
    private readonly els: () => PanelElements,
    private readonly session: PanelSession,
  ) {}

  /** Keep `devices` and rebuild the options from them. */
  setDevices(devices: Device[]): void {
    this.devices = devices;
    this.render();
  }

  /** Whether `deviceId` is still a saved device (of any kind). */
  hasDevice(deviceId: string): boolean {
    return this.devices.some((device) => device.id === deviceId);
  }

  /** `deviceId` when it is a browsable device, else `null`. */
  knownBrowsable(deviceId: string | null): string | null {
    const known = browsableDevices(this.devices).some((device) => device.id === deviceId);
    return known ? deviceId : null;
  }

  /** Rebuild the options from the browsable devices, keeping the selection
   * when it still exists. */
  render(): void {
    const options = browsableDevices(this.devices).map((device) => option(device.id, device.name));
    this.els().deviceSelect.replaceChildren(option("", t("sftp.selectDevice")), ...options);
    this.sync();
  }

  /** Point the picker at the connected/selected device (falls back to the
   * placeholder). */
  sync(): void {
    this.els().deviceSelect.value = this.session.shownDeviceId() ?? "";
  }
}

function option(value: string, label: string): HTMLOptionElement {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  return element;
}
