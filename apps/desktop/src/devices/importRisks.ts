/**
 * The confirmation text for a devices import whose file carries settings that
 * act on this machine (see `previewDevicesImport`). Device names come from the
 * file, so each is flattened to one line: a name can't fake another entry.
 */

import type { DeviceRisks, ImportRisk } from "../ipc";
import { t, tp } from "../i18n";
import type { MessageKey } from "../i18n/en";

/** How many devices the confirmation names before counting the rest. */
export const MAX_LISTED_DEVICES = 8;

const RISK_LABELS: Record<ImportRisk, MessageKey> = {
  agentForwarding: "devices.importRisk.agentForwarding",
  autoStartForwards: "devices.importRisk.autoStartForwards",
  autoStartRemoteForwards: "devices.importRisk.autoStartRemoteForwards",
  customShell: "devices.importRisk.customShell",
  localSnippet: "devices.importRisk.localSnippet",
  networkKeyPath: "devices.importRisk.networkKeyPath",
  networkSerialPort: "devices.importRisk.networkSerialPort",
  networkShellDir: "devices.importRisk.networkShellDir",
  replacesForwards: "devices.importRisk.replacesForwards",
};

export function importRiskMessage(devices: DeviceRisks[]): string {
  const lines = devices.slice(0, MAX_LISTED_DEVICES).map(riskLine);
  const unlisted = devices.length - MAX_LISTED_DEVICES;
  if (unlisted > 0) lines.push(tp("devices.importRisks.more", unlisted));
  return [t("devices.importRisks.lead"), ...lines, t("devices.importRisks.advice")].join("\n");
}

function riskLine(device: DeviceRisks): string {
  const name = device.name.replace(/\s+/g, " ").trim();
  const risks = device.risks.map((risk) => t(RISK_LABELS[risk])).join(", ");
  return `• ${name}: ${risks}`;
}
