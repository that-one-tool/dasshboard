import { describe, it, expect } from "vitest";
import type { GridModel } from "../gridModel";
import type { Profile } from "../ipc";
import {
  SIZE_EPSILON,
  gridsEqual,
  isDirty,
  panesEqual,
  profileToSnapshot,
  shouldConfirmTeardown,
  sizesEqual,
  snapshotToProfileFields,
  workspaceMatchesProfile,
  type WorkspaceSnapshot,
} from "./workspace";

function grid(): GridModel {
  return { rows: 2, cols: 2, rowSizes: [0.5, 0.5], colSizes: [0.6, 0.4] };
}

function snapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return { grid: grid(), panes: ["dev-1", null, "dev-2", null], ...overrides };
}

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: "p1",
    name: "Homelab",
    grid: grid(),
    panes: [
      { deviceId: "dev-1" },
      { deviceId: null },
      { deviceId: "dev-2" },
      { deviceId: null },
    ],
    ...overrides,
  };
}

describe("sizesEqual", () => {
  it("is true for identical arrays", () => {
    expect(sizesEqual([0.5, 0.5], [0.5, 0.5])).toBe(true);
  });
  it("is false for different lengths", () => {
    expect(sizesEqual([1], [0.5, 0.5])).toBe(false);
  });
  it("tolerates float drift below the epsilon (nudge-and-return)", () => {
    expect(sizesEqual([0.5, 0.5], [0.5 + SIZE_EPSILON / 2, 0.5 - SIZE_EPSILON / 2])).toBe(true);
  });
  it("detects a real resize above the epsilon", () => {
    expect(sizesEqual([0.5, 0.5], [0.6, 0.4])).toBe(false);
  });
});

describe("gridsEqual", () => {
  it("is true for the same shape and sizes", () => {
    expect(gridsEqual(grid(), grid())).toBe(true);
  });
  it("is false when rows/cols differ", () => {
    expect(gridsEqual(grid(), { ...grid(), rows: 1 })).toBe(false);
  });
  it("is false when a size changes beyond epsilon", () => {
    expect(gridsEqual(grid(), { ...grid(), colSizes: [0.7, 0.3] })).toBe(false);
  });
  it("is true when a size drifts within epsilon", () => {
    expect(gridsEqual(grid(), { ...grid(), colSizes: [0.6 + SIZE_EPSILON / 2, 0.4] })).toBe(true);
  });
});

describe("panesEqual", () => {
  it("is true for identical assignments", () => {
    expect(panesEqual(["a", null], ["a", null])).toBe(true);
  });
  it("is false when a device assignment differs", () => {
    expect(panesEqual(["a", null], ["a", "b"])).toBe(false);
  });
  it("is false for different lengths", () => {
    expect(panesEqual(["a"], ["a", null])).toBe(false);
  });
});

describe("profileToSnapshot / snapshotToProfileFields round-trip", () => {
  it("maps panes to/from deviceId arrays", () => {
    const snap = profileToSnapshot(profile());
    expect(snap.panes).toEqual(["dev-1", null, "dev-2", null]);
    const fields = snapshotToProfileFields(snap);
    expect(fields.panes).toEqual([
      { deviceId: "dev-1" },
      { deviceId: null },
      { deviceId: "dev-2" },
      { deviceId: null },
    ]);
    expect(fields.grid).toEqual(grid());
  });
});

describe("workspaceMatchesProfile", () => {
  it("matches an identical workspace", () => {
    expect(workspaceMatchesProfile(snapshot(), profile())).toBe(true);
  });
  it("does not match when a pane device changed", () => {
    expect(workspaceMatchesProfile(snapshot({ panes: ["dev-9", null, "dev-2", null] }), profile())).toBe(false);
  });
  it("does not match when the grid shape changed", () => {
    expect(
      workspaceMatchesProfile(snapshot({ grid: { rows: 1, cols: 2, rowSizes: [1], colSizes: [0.6, 0.4] }, panes: ["dev-1", null] }), profile()),
    ).toBe(false);
  });
  it("matches after a splitter nudge-and-return (within epsilon)", () => {
    const nudged = snapshot({ grid: { ...grid(), colSizes: [0.6 + SIZE_EPSILON / 2, 0.4 - SIZE_EPSILON / 2] } });
    expect(workspaceMatchesProfile(nudged, profile())).toBe(true);
  });
});

describe("isDirty", () => {
  it("is false when no profile is loaded", () => {
    expect(isDirty(snapshot(), null)).toBe(false);
  });
  it("is false when the workspace matches the loaded profile", () => {
    expect(isDirty(snapshot(), profile())).toBe(false);
  });
  it("is true when a device assignment changed", () => {
    expect(isDirty(snapshot({ panes: ["dev-1", "dev-3", "dev-2", null] }), profile())).toBe(true);
  });
  it("is true when the grid was resized past epsilon", () => {
    expect(isDirty(snapshot({ grid: { ...grid(), rowSizes: [0.7, 0.3] } }), profile())).toBe(true);
  });
});

describe("shouldConfirmTeardown", () => {
  it("confirms when at least one session is live", () => {
    expect(shouldConfirmTeardown(1)).toBe(true);
    expect(shouldConfirmTeardown(4)).toBe(true);
  });
  it("does not confirm when nothing is live", () => {
    expect(shouldConfirmTeardown(0)).toBe(false);
  });
});
