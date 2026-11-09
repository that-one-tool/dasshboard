/** Name clashes of a transfer: asking for a conflict policy, and where a file
 * goes under it (kept, skipped, or renamed to a free `<name> (N)`). */

import { join } from "@tauri-apps/api/path";
import { sftpExists, sftpLocalExists, type AppError, type ConflictPolicy, type SftpEntry } from "../../ipc";
import { t } from "../../i18n";
import { chooseConflict } from "../../ui/confirm";
import { findFreeName } from "./freeName";

export interface LocalTarget {
  entry: SftpEntry;
  target: string;
}

/**
 * The conflict policy for a transfer: `"overwrite"` when there is no clash,
 * otherwise the user's choice from the conflict dialog (or `null` if they
 * cancel). One choice applies to the whole operation.
 */
export async function resolvePolicy(conflict: boolean, message: string): Promise<ConflictPolicy | null> {
  if (!conflict) return "overwrite";
  return chooseConflict(message);
}

export function conflictMessage(name: string): string {
  return t("sftp.conflict.message", { name });
}

/** The conflict dialog's text for a batch: by name for one entry. */
export function bulkConflictMessage(entries: readonly SftpEntry[]): string {
  const [only] = entries;
  if (entries.length !== 1 || !only) return t("sftp.conflict.messageMany");
  return conflictMessage(only.name);
}

/** Where a single-file upload goes: `remote` itself, or — when a file of
 * that name is already there — what the conflict dialog picks (`null` to
 * upload nothing). */
export async function uploadTarget(deviceId: string, remote: string, name: string): Promise<string | null> {
  const exists = await sftpExists(deviceId, remote);
  const policy = await resolvePolicy(exists, conflictMessage(name));
  if (policy === "rename") return freshRemoteName(deviceId, remote, name);
  return policy === "overwrite" ? remote : null;
}

/** A free `<path> (N)` on the server (`path` itself is taken). */
export async function freshRemoteName(deviceId: string, path: string, name: string): Promise<string> {
  const free = await findFreeName(path, (candidate) => sftpExists(deviceId, candidate));
  if (free !== null) return free;
  throw { code: "Sftp", message: t("sftp.upload.noFreeName", { name }) } satisfies AppError;
}

/** `path`, or a free `<path> (N)` when it exists locally (the per-file
 * rename policy in a bulk download). */
export async function freshLocalName(path: string, name: string): Promise<string> {
  if (!(await sftpLocalExists(path))) return path;
  const free = await findFreeName(path, sftpLocalExists);
  if (free !== null) return free;
  throw { code: "Sftp", message: t("sftp.download.noFreeName", { name }) } satisfies AppError;
}

/** Where one file of a bulk download goes, or `null` to skip it. */
export async function bulkFileDestination(
  target: string,
  name: string,
  policy: ConflictPolicy,
): Promise<string | null> {
  if (policy === "rename") return freshLocalName(target, name);
  return (await shouldSkipExisting(target, policy)) ? null : target;
}

/** Each entry's local download path, and whether any of them exists. */
export async function resolveLocalTargets(
  entries: readonly SftpEntry[],
  dest: string,
): Promise<{ targets: LocalTarget[]; conflict: boolean }> {
  const targets: LocalTarget[] = [];
  let conflict = false;
  for (const entry of entries) {
    const target = await join(dest, entry.name);
    targets.push({ entry, target });
    conflict ||= await sftpLocalExists(target);
  }
  return { targets, conflict };
}

async function shouldSkipExisting(target: string, policy: ConflictPolicy): Promise<boolean> {
  return policy === "skip" && (await sftpLocalExists(target));
}
