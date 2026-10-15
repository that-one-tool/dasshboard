/** A pane header's device dropdown and endpoint tooltip. */

import type { Device } from "../../ipc";
import { t } from "../../i18n";
import { requireEl } from "../../ui/dom";
import { deviceEndpoint } from "../../devices/deviceEndpoint";

/** Dropdown label for a device: its name plus its endpoint. */
export function deviceOptionLabel(device: Device): string {
  return `${device.name} (${deviceEndpoint(device)})`;
}

export class DeviceSelect {
  private readonly dropdown: HTMLSelectElement;
  private readonly header: HTMLElement;

  constructor(root: HTMLElement, onPick: (deviceId: string) => void) {
    this.dropdown = requireEl<HTMLSelectElement>(root, ".pane-device-select");
    this.header = requireEl<HTMLElement>(root, ".pane-header");
    this.dropdown.addEventListener("change", () => onPick(this.dropdown.value));
  }

  /** (Re)populates the options, keeping `selectedId` (else the current choice). */
  render(devices: Device[], selectedId: string | null): void {
    const previous = selectedId ?? this.dropdown.value;
    this.dropdown.replaceChildren(...optionsFor(devices, previous));
  }

  value(): string {
    return this.dropdown.value;
  }

  select(deviceId: string | null): void {
    this.dropdown.value = deviceId ?? "";
  }

  setLocked(locked: boolean): void {
    this.dropdown.disabled = locked;
  }

  /** `host:port` for SSH, `portName @ baudRate` for serial. */
  showEndpoint(device: Device | undefined): void {
    if (device) this.header.title = deviceEndpoint(device);
    else this.header.removeAttribute("title");
  }
}

function optionsFor(devices: Device[], selectedId: string): HTMLOptionElement[] {
  if (devices.length === 0) return [emptyOption()];
  return devices.map((device) => deviceOption(device, selectedId));
}

function emptyOption(): HTMLOptionElement {
  const option = makeOption("", t("pane.noDevices"), true);
  option.disabled = true;
  return option;
}

function deviceOption(device: Device, selectedId: string): HTMLOptionElement {
  return makeOption(device.id, deviceOptionLabel(device), device.id === selectedId);
}

function makeOption(value: string, label: string, selected: boolean): HTMLOptionElement {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  option.selected = selected;
  return option;
}
