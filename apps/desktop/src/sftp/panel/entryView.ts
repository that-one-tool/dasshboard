/** The Files panel's view of a listing: name filter + sort, folders on top. */

import type { SftpEntry } from "../../ipc";

export type SortKey = "name" | "size" | "modified";
export type SortDir = "asc" | "desc";

export interface SortState {
  key: SortKey;
  dir: SortDir;
}

export const DEFAULT_SORT: SortState = { key: "name", dir: "asc" };

/** Clicking the active column flips it; another column starts ascending. */
export function nextSort(sort: SortState, key: SortKey): SortState {
  if (sort.key !== key) return { key, dir: "asc" };
  return { key, dir: sort.dir === "asc" ? "desc" : "asc" };
}

export function viewEntries(entries: readonly SftpEntry[], filter: string, sort: SortState): SftpEntry[] {
  const needle = filter.trim().toLowerCase();
  const shown = entries.filter((e) => e.name.toLowerCase().includes(needle));
  return shown.sort((a, b) => compareEntries(a, b, sort));
}

const byName = (a: SftpEntry, b: SftpEntry): number =>
  a.name.toLowerCase().localeCompare(b.name.toLowerCase());

/** An entry without a modification time sorts as the oldest. */
const mtime = (entry: SftpEntry): number => entry.modified ?? 0;

/** Each key's order; ties fall back to the name. */
const BY_KEY: Record<SortKey, (a: SftpEntry, b: SftpEntry) => number> = {
  name: byName,
  size: (a, b) => a.size - b.size || byName(a, b),
  modified: (a, b) => mtime(a) - mtime(b) || byName(a, b),
};

function compareEntries(a: SftpEntry, b: SftpEntry, sort: SortState): number {
  const folderOrder = Number(b.kind === "dir") - Number(a.kind === "dir");
  if (folderOrder !== 0) return folderOrder;
  const order = BY_KEY[sort.key](a, b);
  return sort.dir === "asc" ? order : -order;
}
