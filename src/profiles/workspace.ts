/**
 * Pure workspace ↔ profile logic (Phase 4): snapshotting the live grid into a
 * comparable shape, diffing it against a loaded profile for the dirty-state dot,
 * and the small load/teardown decisions. No DOM, no IPC — everything here is
 * unit-tested in `workspace.test.ts`, mirroring the `gridModel.ts`/`overlay.ts`
 * pure/glue split.
 */

import type { GridModel } from "../gridModel";
import type { Profile } from "../ipc";

/**
 * A comparable snapshot of the live workspace: the grid shape/sizes plus the
 * per-pane device assignment in row-major order (`null` = empty pane). This is
 * exactly the information a `Profile` persists (SPEC §4), minus id/name.
 */
export interface WorkspaceSnapshot {
  grid: GridModel;
  panes: (string | null)[];
}

/**
 * Tolerance for comparing splitter size fractions. A deliberate splitter drag
 * moves a track by whole percent; this epsilon (0.01%) sits far below that but
 * above the sub-1e-6 float noise that a nudge-and-return can leave behind, so a
 * splitter dragged and put back does NOT read as dirty (a false-positive the
 * Phase 4 review specifically probes), while any real resize does.
 */
export const SIZE_EPSILON = 1e-4;

export function sizesEqual(
  a: readonly number[],
  b: readonly number[],
  epsilon: number = SIZE_EPSILON,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    if (av === undefined || bv === undefined) return false;
    if (Math.abs(av - bv) > epsilon) return false;
  }
  return true;
}

export function gridsEqual(a: GridModel, b: GridModel): boolean {
  return (
    a.rows === b.rows &&
    a.cols === b.cols &&
    sizesEqual(a.rowSizes, b.rowSizes) &&
    sizesEqual(a.colSizes, b.colSizes)
  );
}

export function panesEqual(
  a: readonly (string | null)[],
  b: readonly (string | null)[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if ((a[i] ?? null) !== (b[i] ?? null)) return false;
  }
  return true;
}

/** A profile as a comparable snapshot (drops id/name). */
export function profileToSnapshot(profile: Profile): WorkspaceSnapshot {
  return { grid: profile.grid, panes: profile.panes.map((p) => p.deviceId) };
}

/** The grid + panes half of a `Profile`, ready to attach an id/name and save. */
export function snapshotToProfileFields(
  snapshot: WorkspaceSnapshot,
): Pick<Profile, "grid" | "panes"> {
  return {
    grid: snapshot.grid,
    panes: snapshot.panes.map((deviceId) => ({ deviceId })),
  };
}

/** True when the live snapshot matches the profile's grid + pane assignments. */
export function workspaceMatchesProfile(
  snapshot: WorkspaceSnapshot,
  profile: Profile,
): boolean {
  const other = profileToSnapshot(profile);
  return gridsEqual(snapshot.grid, other.grid) && panesEqual(snapshot.panes, other.panes);
}

/**
 * Whether the workspace is "dirty" relative to the loaded profile. With no
 * profile loaded (fresh 1x1 start) there is nothing to diff against, so the
 * workspace is never dirty (the toolbar simply shows no profile name).
 */
export function isDirty(snapshot: WorkspaceSnapshot, loaded: Profile | null): boolean {
  if (!loaded) return false;
  return !workspaceMatchesProfile(snapshot, loaded);
}

/**
 * Load flow (SPEC §7): tearing down the current workspace to load a profile
 * needs a confirmation only when at least one pane has a live session.
 */
export function shouldConfirmTeardown(liveSessionCount: number): boolean {
  return liveSessionCount > 0;
}
