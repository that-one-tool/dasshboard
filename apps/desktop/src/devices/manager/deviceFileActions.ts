/** The device list's file actions — export/import as JSON or as an OpenSSH
 * client config — one table row per toolbar button. Each picks a path (a
 * cancelled picker is a silent no-op), runs, then reports a toast. */

import {
  exportDevices,
  exportSshConfig,
  importDevices,
  importSshConfig,
  previewDevicesImport,
  type DeviceRisks,
} from "../../ipc";
import { t, tp } from "../../i18n";
import { confirm } from "../../ui/confirm";
import { pickJsonOpenPath, pickJsonSavePath, pickSshConfigOpenPath, pickSshConfigSavePath } from "../../ui/fileDialog";
import { importRiskMessage } from "../importRisks";
import type { DeviceFeedback } from "./deviceFeedback";

export interface FileAction {
  /** The toolbar button that runs it. */
  selector: string;
  pick(): Promise<string | null>;
  /** Runs on the picked path; resolves the success message, or `null` when
   * the user backed out. */
  run(path: string): Promise<string | null>;
  /** Whether the device list changed and must be reloaded. */
  reloads: boolean;
}

export interface FileActionContext {
  feedback: DeviceFeedback;
  reload(): Promise<void>;
}

export const FILE_ACTIONS: readonly FileAction[] = [
  { selector: ".device-export-btn", pick: () => pickJsonSavePath("dasshboard-devices.json"), run: exportJson, reloads: false },
  { selector: ".device-import-btn", pick: pickJsonOpenPath, run: importJson, reloads: true },
  { selector: ".device-import-ssh-btn", pick: pickSshConfigOpenPath, run: importSsh, reloads: true },
  { selector: ".device-export-ssh-btn", pick: pickSshConfigSavePath, run: exportSsh, reloads: false },
];

/** Runs `action`; the success toast comes before the reload, so `main.ts`
 * refreshes the pane dropdowns and profiles too. */
export async function runFileAction(action: FileAction, context: FileActionContext): Promise<void> {
  try {
    await completeFileAction(action, context);
  } catch (err) {
    context.feedback.error(err);
  }
}

async function completeFileAction(action: FileAction, context: FileActionContext): Promise<void> {
  const message = await pickThenRun(action);
  if (message === null) return;
  context.feedback.success(message);
  if (action.reloads) await context.reload();
}

async function pickThenRun(action: FileAction): Promise<string | null> {
  const path = await action.pick();
  return path === null ? null : action.run(path);
}

/** The backend writes the file, never including secrets. */
async function exportJson(path: string): Promise<string> {
  return tp("devices.exported", await exportDevices(path));
}

/** Upserts by id, once the user confirmed any settings that would act on this machine. */
async function importJson(path: string): Promise<string | null> {
  const risks = await previewDevicesImport(path);
  if (!(await acceptImportRisks(risks))) return null;
  return tp("devices.imported", await importDevices(path, risks));
}

async function acceptImportRisks(risks: DeviceRisks[]): Promise<boolean> {
  return risks.length === 0 || confirmImportRisks(risks);
}

function confirmImportRisks(risks: DeviceRisks[]): Promise<boolean> {
  return confirm(importRiskMessage(risks), {
    title: t("devices.importRisks.title"),
    confirmLabel: t("devices.importRisks.confirm"),
    danger: true,
    keepLineBreaks: true,
  });
}

/** Upserts each concrete host; skipped ones are wildcard/`Match`-only blocks,
 * entries missing a username, or duplicates of existing devices. */
async function importSsh(path: string): Promise<string> {
  const { imported, skipped } = await importSshConfig(path);
  return countMessage("devices.importedSsh", imported, skipped);
}

/** Writes every SSH device; non-SSH devices are skipped. */
async function exportSsh(path: string): Promise<string> {
  const { exported, skipped } = await exportSshConfig(path);
  return countMessage("devices.exportedSsh", exported, skipped);
}

/** `key` with the count, or `<key>Skipped` also naming the skipped count. */
function countMessage(key: "devices.importedSsh" | "devices.exportedSsh", count: number, skipped: number): string {
  return skipped > 0 ? tp(`${key}Skipped`, count, { skipped }) : tp(key, count);
}
