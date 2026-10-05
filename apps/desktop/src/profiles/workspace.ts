/**
 * Pure workspace ↔ profile logic (Phase 4): snapshotting the live grid into a
 * comparable shape, diffing it against a loaded profile for the dirty-state dot,
 * and the small load/teardown decisions. No DOM, no IPC — everything here is
 * unit-tested in `workspace.test.ts`, mirroring the `gridModel.ts`/`overlay.ts`
 * pure/glue split.
 */

import type { GridModel } from "../gridModel";
import type { Profile, ProfileTab } from "../ipc";
import { t, tp } from "../i18n";

/**
 * A comparable snapshot of the live workspace: the grid shape/sizes plus the
 * per-pane device assignment in row-major order (`null` = empty pane). This is
 * exactly the information a profile tab persists (SPEC §4), minus its name.
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

/** An open tab as a comparable snapshot: its name plus its workspace. */
export interface TabSnapshot extends WorkspaceSnapshot {
  name: string;
}

/** A profile tab as a comparable workspace snapshot (drops the name). */
export function profileTabToSnapshot(tab: ProfileTab): WorkspaceSnapshot {
  return { grid: tab.grid, panes: tab.panes.map((p) => p.deviceId) };
}

/** An open tab's snapshot as a profile tab, ready to save. */
export function snapshotToProfileTab(tab: TabSnapshot): ProfileTab {
  return {
    name: tab.name,
    grid: tab.grid,
    panes: tab.panes.map((deviceId) => ({ deviceId })),
  };
}

function tabMatches(tab: TabSnapshot, saved: ProfileTab): boolean {
  const other = profileTabToSnapshot(saved);
  return (
    tab.name === saved.name &&
    gridsEqual(tab.grid, other.grid) &&
    panesEqual(tab.panes, other.panes)
  );
}

/** True when the open tabs (in strip order) match the profile's tabs one for
 * one: same count, order, names, grids and pane assignments. */
export function tabsMatchProfile(tabs: readonly TabSnapshot[], profile: Profile): boolean {
  if (tabs.length !== profile.tabs.length) return false;
  return tabs.every((tab, i) => {
    const saved = profile.tabs[i];
    return saved !== undefined && tabMatches(tab, saved);
  });
}

/**
 * Whether a profile's open tabs are "dirty" relative to it. With no profile
 * loaded, or none of its tabs open, there is nothing to diff against, so it is
 * never dirty.
 */
export function isDirty(tabs: readonly TabSnapshot[], loaded: Profile | null): boolean {
  if (!loaded || tabs.length === 0) return false;
  return !tabsMatchProfile(tabs, loaded);
}

/** The profile with its first tab renamed (for the v1 upgrade, see
 * `ProfileManager`). */
export function withFirstTabName(profile: Profile, name: string): Profile {
  return {
    ...profile,
    tabs: profile.tabs.map((tab, i) => (i === 0 ? { ...tab, name } : tab)),
  };
}

/**
 * Load flow (SPEC §7): tearing down the current workspace to load a profile
 * needs a confirmation only when at least one pane has a live session.
 */
export function shouldConfirmTeardown(liveSessionCount: number): boolean {
  return liveSessionCount > 0;
}

/**
 * Loading a profile over tabs closes them: confirm when any has a live session,
 * or when it closes more than one (a whole group, possibly in the background,
 * which the user may not see).
 */
export function shouldConfirmReplace(tabCount: number, liveSessionCount: number): boolean {
  return liveSessionCount > 0 || tabCount > 1;
}

/** The replace confirm's text: how many tabs close, then how many live sessions. */
export function replaceConfirmMessage(tabCount: number, liveSessionCount: number): string {
  const sessions =
    liveSessionCount > 0 ? tp("grid.shrink", liveSessionCount) : t("profiles.replace.continue");
  return `${tp("profiles.replace.tabs", tabCount)} ${sessions}`;
}
