/**
 * Pure helpers for the device sidebar's search + tag grouping (feature #3).
 *
 * No DOM, no i18n, no side effects — so the search-match, tag-parse and
 * group-by-tag rules are unit-testable in isolation, mirroring how
 * `validation.ts` keeps the form rules out of `deviceManager.ts`.
 */

import type { Device } from "../ipc";
import { deviceEndpoint } from "./deviceEndpoint";

/**
 * Parse a raw tags input (comma- or newline-separated) into a clean list:
 * trimmed, empties dropped, and de-duplicated case-insensitively while keeping
 * the first occurrence's original casing and the input order. This is what a
 * save persists, so `"prod, Prod ,  , web"` becomes `["prod", "web"]`.
 */
export function parseTags(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of raw.split(/[,\n]/)) {
    const tag = piece.trim();
    if (tag === "") continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/**
 * True when a device matches a search query (case-insensitive substring over
 * its name, its endpoint — `host:port` for SSH, `portName @ baud` for serial —
 * and any of its tags). An empty/whitespace query matches everything.
 */
export function deviceMatchesQuery(device: Device, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  if (device.name.toLowerCase().includes(q)) return true;
  if (deviceEndpoint(device).toLowerCase().includes(q)) return true;
  return device.tags.some((tag) => tag.toLowerCase().includes(q));
}

/** Filter a device list by a search query (preserves input order). */
export function filterDevices(devices: Device[], query: string): Device[] {
  return devices.filter((d) => deviceMatchesQuery(d, query));
}

/** A named group of devices for the sidebar: `tag` is `null` for untagged. */
export interface DeviceGroup {
  tag: string | null;
  devices: Device[];
}

/**
 * Group devices by their *first* tag (a device belongs to exactly one group, so
 * the list never shows the same device twice). Tagged groups come first, sorted
 * alphabetically (case-insensitive) by tag, with the untagged group (`tag:
 * null`) always last. Devices keep their original order within each group.
 *
 * When no device carries a tag the result is a single untagged group, which the
 * sidebar renders as a plain flat list (no group header).
 */
export function groupDevicesByFirstTag(devices: Device[]): DeviceGroup[] {
  // Bucket case-insensitively so "Prod" and "prod" are one group, keeping the
  // first-seen casing as the display label (matches `parseTags`' dedupe).
  const byTag = new Map<string, { label: string; devices: Device[] }>();
  const untagged: Device[] = [];

  for (const device of devices) {
    const first = device.tags[0];
    if (first === undefined) {
      untagged.push(device);
      continue;
    }
    const key = first.toLowerCase();
    const bucket = byTag.get(key);
    if (bucket) bucket.devices.push(device);
    else byTag.set(key, { label: first, devices: [device] });
  }

  const groups: DeviceGroup[] = [...byTag.values()]
    .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()))
    .map(({ label, devices: list }) => ({ tag: label, devices: list }));

  if (untagged.length > 0) groups.push({ tag: null, devices: untagged });
  return groups;
}
