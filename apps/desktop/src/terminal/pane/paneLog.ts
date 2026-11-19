/** A pane's lines in the diagnostic log (Logs dialog). Never terminal data. */

import { logToBackend, warnThrottled } from "../../ipc";
import type { InputHealth } from "../inputQueue";

export function shellLabel(deviceName: string): string {
  return `shell ${deviceName}`;
}

const INPUT_HEALTH_LOGS: Record<InputHealth, (deviceName: string, label: string) => void> = {
  stalled: (deviceName, label) =>
    warnThrottled(`input stall ${deviceName}`, `${label}: input not responding; keys typed now are queued`),
  ok: (_deviceName, label) => logToBackend("info", `${label}: input responding again`),
  lost: (_deviceName, label) => logToBackend("warn", `${label}: input stopped: reconnect`),
};

export function logInputHealth(deviceName: string, health: InputHealth): void {
  INPUT_HEALTH_LOGS[health](deviceName, shellLabel(deviceName));
}

export function logReadTimeout(deviceName: string, unanswered: number): void {
  const line = `${shellLabel(deviceName)}: output read unanswered (${unanswered} in a row)`;
  warnThrottled(`read timeout ${deviceName}`, line);
}

export function logCloseFailed(deviceName: string, message: string): void {
  logToBackend("warn", `${shellLabel(deviceName)}: close failed: ${message}`);
}
