import { describe, it, expect } from "vitest";
import type { GridModel } from "../gridModel";
import type { Profile, ProfileTab } from "../ipc";
import {
  SIZE_EPSILON,
  gridsEqual,
  isDirty,
  panesEqual,
  profileTabToSnapshot,
  replaceConfirmMessage,
  shouldConfirmReplace,
  shouldConfirmTeardown,
  sizesEqual,
  snapshotToProfileTab,
  tabsMatchProfile,
  withFirstTabName,
  type TabSnapshot,
} from "./workspace";

function grid(): GridModel {
  return { rows: 2, cols: 2, rowSizes: [0.5, 0.5], colSizes: [0.6, 0.4] };
}

/** The open tab matching the profile's first tab ("Web", 2x2). */
function webTab(overrides: Partial<TabSnapshot> = {}): TabSnapshot {
  return { name: "Web", grid: grid(), panes: ["dev-1", null, "dev-2", null], ...overrides };
}

/** The open tab matching the profile's second tab ("DB", an empty 1x1). */
function dbTab(overrides: Partial<TabSnapshot> = {}): TabSnapshot {
  return { name: "DB", grid: oneByOne(), panes: [null], ...overrides };
}

function oneByOne(): GridModel {
  return { rows: 1, cols: 1, rowSizes: [1], colSizes: [1] };
}

function profileTab(): ProfileTab {
  return {
    name: "Web",
    grid: grid(),
    panes: [
      { deviceId: "dev-1" },
      { deviceId: null },
      { deviceId: "dev-2" },
      { deviceId: null },
    ],
  };
}

/** Two tabs: "Web" (2x2) then "DB" (an empty 1x1). */
function profile(): Profile {
  return {
    id: "p1",
    name: "Homelab",
    tabs: [profileTab(), { name: "DB", grid: oneByOne(), panes: [{ deviceId: null }] }],
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

describe("profileTabToSnapshot / snapshotToProfileTab round-trip", () => {
  it("maps panes to/from deviceId arrays and keeps the tab name", () => {
    const snap = profileTabToSnapshot(profileTab());
    expect(snap.panes).toEqual(["dev-1", null, "dev-2", null]);
    const tab = snapshotToProfileTab({ name: "Web", ...snap });
    expect(tab).toEqual(profileTab());
  });
});

describe("tabsMatchProfile", () => {
  it("matches identical tabs", () => {
    expect(tabsMatchProfile([webTab(), dbTab()], profile())).toBe(true);
  });
  it("does not match when a pane device changed", () => {
    expect(tabsMatchProfile([webTab({ panes: ["dev-9", null, "dev-2", null] }), dbTab()], profile())).toBe(false);
  });
  it("does not match when the grid shape changed", () => {
    const reshaped = webTab({ grid: { rows: 1, cols: 2, rowSizes: [1], colSizes: [0.6, 0.4] }, panes: ["dev-1", null] });
    expect(tabsMatchProfile([reshaped, dbTab()], profile())).toBe(false);
  });
  it("matches after a splitter nudge-and-return (within epsilon)", () => {
    const nudged = webTab({ grid: { ...grid(), colSizes: [0.6 + SIZE_EPSILON / 2, 0.4 - SIZE_EPSILON / 2] } });
    expect(tabsMatchProfile([nudged, dbTab()], profile())).toBe(true);
  });
  it("does not match when a tab was renamed", () => {
    expect(tabsMatchProfile([webTab(), dbTab({ name: "Logs" })], profile())).toBe(false);
  });
  it("does not match when a tab was added or closed", () => {
    expect(tabsMatchProfile([webTab()], profile())).toBe(false);
    expect(tabsMatchProfile([webTab(), dbTab(), dbTab()], profile())).toBe(false);
  });
  it("does not match when the tabs were reordered", () => {
    expect(tabsMatchProfile([dbTab(), webTab()], profile())).toBe(false);
  });
});

describe("isDirty", () => {
  it("is false when no profile is loaded", () => {
    expect(isDirty([webTab()], null)).toBe(false);
  });
  it("is false when none of the profile's tabs is open", () => {
    expect(isDirty([], profile())).toBe(false);
  });
  it("is false when the tabs match the loaded profile", () => {
    expect(isDirty([webTab(), dbTab()], profile())).toBe(false);
  });
  it("is true when a device assignment changed", () => {
    expect(isDirty([webTab({ panes: ["dev-1", "dev-3", "dev-2", null] }), dbTab()], profile())).toBe(true);
  });
  it("is true when the grid was resized past epsilon", () => {
    expect(isDirty([webTab({ grid: { ...grid(), rowSizes: [0.7, 0.3] } }), dbTab()], profile())).toBe(true);
  });
  it("is true when one of the tabs was closed", () => {
    expect(isDirty([webTab()], profile())).toBe(true);
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

describe("shouldConfirmReplace", () => {
  it("confirms when a session is live", () => {
    expect(shouldConfirmReplace(1, 1)).toBe(true);
  });
  it("confirms when more than one tab will close, even with nothing live", () => {
    expect(shouldConfirmReplace(2, 0)).toBe(true);
  });
  it("does not confirm replacing a single idle tab", () => {
    expect(shouldConfirmReplace(1, 0)).toBe(false);
  });
});

describe("replaceConfirmMessage", () => {
  it("names the tab count, then the live sessions", () => {
    expect(replaceConfirmMessage(2, 3)).toBe(
      "2 tabs will be closed. 3 active sessions will be closed. Continue?",
    );
  });
  it("names the tab count alone when nothing is live", () => {
    expect(replaceConfirmMessage(1, 0)).toBe("1 tab will be closed. Continue?");
  });
});

describe("withFirstTabName", () => {
  it("renames only the first tab", () => {
    const renamed = withFirstTabName(profile(), "Tab 1");
    expect(renamed.tabs.map((t) => t.name)).toEqual(["Tab 1", "DB"]);
    expect(profile().tabs[0]?.name).toBe("Web");
  });
});
