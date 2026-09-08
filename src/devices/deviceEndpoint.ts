/**
 * A device's endpoint text: `host:port` for an SSH device, `portName @ baudRate`
 * for a serial device. Lives in the device domain (rather than in a terminal or
 * UI module) because it's shared display logic used by the sidebar device list,
 * the pane dropdown, and the pane header tooltip — a serial device must never
 * show a meaningless `host:port`.
 */

import type { Device } from "../ipc";

export function deviceEndpoint(device: Device): string {
  return device.kind === "serial"
    ? `${device.portName} @ ${device.baudRate}`
    : `${device.host}:${device.port}`;
}
