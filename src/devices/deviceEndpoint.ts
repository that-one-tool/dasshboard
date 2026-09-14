/**
 * A device's endpoint text: `host:port` for an SSH device, `portName @ baudRate`
 * for a serial device, and the shell path (or a generic label) for a local
 * shell. Lives in the device domain (rather than in a terminal or UI module)
 * because it's shared display logic used by the sidebar device list, the pane
 * dropdown, and the pane header tooltip — a non-SSH device must never show a
 * meaningless `host:port`.
 */

import type { Device } from "../ipc";

export function deviceEndpoint(device: Device): string {
  if (device.kind === "serial") {
    return `${device.portName} @ ${device.baudRate}`;
  }
  if (device.kind === "localShell") {
    const shell = device.shell?.trim();
    return shell && shell !== "" ? shell : "local shell";
  }
  return `${device.host}:${device.port}`;
}
