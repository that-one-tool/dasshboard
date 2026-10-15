/**
 * The Files panel's pending Move ("cut"): survives navigation (cut here →
 * open a folder → paste), but is tied to one connection.
 */

import type { AppError } from "../../ipc";
import { t } from "../../i18n";
import { joinRemote } from "../sftpFormat";

export interface MoveSource {
  deviceId: string;
  dir: string;
  names: string[];
}

/** One name's move, or why it can't be moved. */
export type MoveStep = { from: string; to: string } | { error: AppError };

export class MoveClipboard {
  private source: MoveSource | null = null;

  cut(source: MoveSource): void {
    this.source = source;
  }

  clear(): void {
    this.source = null;
  }

  pending(): MoveSource | null {
    return this.source;
  }

  /** Pasting into the source directory would be a no-op, so it isn't offered. */
  canPasteInto(deviceId: string | null, dir: string): boolean {
    return this.source?.deviceId === deviceId && this.source.dir !== dir;
  }
}

/**
 * The moves of `source`'s names into `dir`, in order. `existing` is `dir`'s
 * listing: checking it avoids relying on a server's undefined
 * overwrite-on-rename behavior.
 */
export function planMoves(source: MoveSource, dir: string, existing: ReadonlySet<string>): MoveStep[] {
  return source.names.map((name) => planMove(joinRemote(source.dir, name), dir, name, existing));
}

function planMove(from: string, dir: string, name: string, existing: ReadonlySet<string>): MoveStep {
  if (isSameOrBelow(dir, from)) return makeRefusal(t("sftp.move.intoSelf"));
  if (existing.has(name)) return makeRefusal(t("sftp.move.exists"));
  return { from, to: joinRemote(dir, name) };
}

function isSameOrBelow(dir: string, folder: string): boolean {
  return dir === folder || dir.startsWith(`${folder}/`);
}

function makeRefusal(message: string): MoveStep {
  return { error: { code: "Validation", message } };
}
