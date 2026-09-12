/**
 * Pure grid math for the multi-pane workspace (SPEC §4/§7, Phase 3). This module
 * is deliberately free of the DOM so it is unit-testable in isolation; the thin
 * glue in `grid.ts` renders the results. It mirrors the pure/glue split used by
 * `overlay.ts` / `pane.ts`.
 *
 * The grid model matches SPEC §4 exactly (`{ rows, cols, rowSizes, colSizes }`,
 * sizes are fractions summing to ≈1) so Phase 4 can persist it verbatim.
 */

import { tp } from "./i18n";

/** Smallest fraction any single track may occupy (SPEC §7 splitter clamp). */
export const MIN_TRACK_FRACTION = 0.15;

/** The grid presets offered in the toolbar (SPEC §7), read as `rows x cols`. */
export const PRESET_IDS = ["1x1", "2x1", "1x2", "2x2", "3x1", "3x2"] as const;
export type PresetId = (typeof PRESET_IDS)[number];

/** Persisted grid shape (SPEC §4). `rowSizes`/`colSizes` are fractions ≈1. */
export interface GridModel {
  rows: number;
  cols: number;
  rowSizes: number[];
  colSizes: number[];
}

/** Number of panes in a model (row-major, length = rows*cols). */
export function paneCount(model: GridModel): number {
  return model.rows * model.cols;
}

/**
 * Normalizes a fraction list so it sums to exactly 1. A non-positive sum (all
 * zero / empty input) falls back to equal fractions, guarding against division
 * by zero and against splitter/normalization drift compounding over time.
 */
export function normalizeSizes(sizes: number[]): number[] {
  const sum = sizes.reduce((acc, x) => acc + x, 0);
  if (sum <= 0) {
    const n = sizes.length;
    return n > 0 ? new Array<number>(n).fill(1 / n) : [];
  }
  return sizes.map((x) => x / sum);
}

/** `n` equal, normalized fractions (empty for `n <= 0`). */
export function equalSizes(n: number): number[] {
  if (n <= 0) return [];
  return normalizeSizes(new Array<number>(n).fill(1 / n));
}

/** Builds the model for a preset, with equal track sizes (SPEC §7). */
export function presetToModel(id: PresetId): GridModel {
  const parts = id.split("x").map((s) => Number.parseInt(s, 10));
  const rows = parts[0] ?? 1;
  const cols = parts[1] ?? 1;
  return {
    rows,
    cols,
    rowSizes: equalSizes(rows),
    colSizes: equalSizes(cols),
  };
}

/**
 * The preset id whose shape matches this model, or `null` for a shape with no
 * preset (used to highlight the active toolbar button). Only rows/cols matter —
 * a model whose sizes drifted from equal still maps to its preset.
 */
export function presetIdFor(model: GridModel): PresetId | null {
  const candidate = `${model.rows}x${model.cols}`;
  return (PRESET_IDS as readonly string[]).includes(candidate)
    ? (candidate as PresetId)
    : null;
}

/**
 * Cumulative boundary fractions for a track list: the running sum after each
 * track except the last, i.e. the positions (0..1) where splitters sit. Length
 * is `sizes.length - 1`.
 */
export function cumulativeFractions(sizes: number[]): number[] {
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < sizes.length - 1; i++) {
    acc += sizes[i] ?? 0;
    out.push(acc);
  }
  return out;
}

/**
 * Applies a splitter drag to a track list. The splitter between track
 * `boundaryIndex` and `boundaryIndex + 1` is moved so the cumulative fraction at
 * the boundary becomes `targetCumulative` (typically the pointer position as a
 * fraction of the container). Only the two adjacent tracks change; their combined
 * size is preserved, each clamped to `MIN_TRACK_FRACTION` (SPEC §7). The result
 * is re-normalized so many successive drags cannot accumulate drift away from 1.
 */
export function resizeTrack(
  sizes: number[],
  boundaryIndex: number,
  targetCumulative: number,
): number[] {
  if (boundaryIndex < 0 || boundaryIndex >= sizes.length - 1) {
    return sizes.slice();
  }
  const result = sizes.slice();
  const first = result[boundaryIndex] ?? 0;
  const second = result[boundaryIndex + 1] ?? 0;
  const pairTotal = first + second;

  // Fractions covered by the tracks before the pair — the boundary can only move
  // within [before + MIN, before + pairTotal - MIN].
  const before = result
    .slice(0, boundaryIndex)
    .reduce((acc, x) => acc + x, 0);

  const minFirst = MIN_TRACK_FRACTION;
  const maxFirst = pairTotal - MIN_TRACK_FRACTION;

  let newFirst = targetCumulative - before;
  if (maxFirst < minFirst) {
    // Degenerate: the pair can't honor two minimums; split it evenly.
    newFirst = pairTotal / 2;
  } else if (newFirst < minFirst) {
    newFirst = minFirst;
  } else if (newFirst > maxFirst) {
    newFirst = maxFirst;
  }

  result[boundaryIndex] = newFirst;
  result[boundaryIndex + 1] = pairTotal - newFirst;
  return normalizeSizes(result);
}

/**
 * How panes map when the cell count changes. Assignments are preserved in
 * **row-major** (linear index) order (SPEC §4/§7): the shared prefix is kept,
 * a shrink drops the tail, a grow appends fresh empty panes.
 */
export interface PaneRemap {
  /** Old indices preserved as-is (0 .. min(old,new)-1). */
  keep: number[];
  /** Old indices removed on a shrink (>= newCount). */
  dropped: number[];
  /** New indices created on a grow (>= oldCount). */
  added: number[];
}

/** Computes the row-major pane remap for a cell-count change. */
export function remapPanes(oldCount: number, newCount: number): PaneRemap {
  const keep: number[] = [];
  const dropped: number[] = [];
  const added: number[] = [];
  const shared = Math.min(oldCount, newCount);
  for (let i = 0; i < shared; i++) keep.push(i);
  for (let i = newCount; i < oldCount; i++) dropped.push(i);
  for (let i = oldCount; i < newCount; i++) added.push(i);
  return { keep, dropped, added };
}

/** Confirmation copy shown before a shrink tears down live sessions (SPEC §7). */
export function shrinkConfirmMessage(liveCount: number): string {
  return tp("grid.shrink", liveCount);
}
