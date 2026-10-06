/**
 * @vitest-environment happy-dom
 *
 * Unit tests for `ProfileManager` (Phase 4) — the sidebar/toolbar orchestration
 * over the profile IPC commands and the tabbed workspace. Drives the class
 * through its rendered DOM (mirroring `deviceManager.test.ts`), with `../ipc`
 * mocked and an in-memory fake of the tab set (`fakeTabs`), whose grids only
 * implement `snapshot()` / `applySnapshot()` / `liveSessionCount()`.
 *
 * A profile is a group of tabs: the open tabs linked to it, in strip order.
 * Covers loading/saving that group, its dirty state, and that a Save after a
 * device deletion persists exactly the current (nulled) snapshot rather than
 * resurrecting a device id.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Grid } from "../grid";
import type { Profile, ProfileTab } from "../ipc";
import type { WorkspaceSnapshot } from "./workspace";

vi.mock("../ipc", () => ({
  listProfiles: vi.fn(),
  saveProfile: vi.fn(),
  deleteProfile: vi.fn(async () => {}),
  setDefaultProfile: vi.fn(async () => {}),
  exportProfiles: vi.fn(),
  importProfiles: vi.fn(),
}));

const { saveMock, openMock } = vi.hoisted(() => ({
  saveMock: vi.fn(),
  openMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => saveMock(...args),
  open: (...args: unknown[]) => openMock(...args),
}));

import { ProfileManager, type ProfileWorkspace } from "./profileManager";
import {
  listProfiles,
  saveProfile,
  exportProfiles,
  importProfiles,
} from "../ipc";

interface FakeTab {
  grid: Grid;
  name: string;
  linked: string | null;
  snap: WorkspaceSnapshot;
  live: number;
  applySnapshot: ReturnType<typeof vi.fn>;
}

type TabSpec = { name?: string; linked?: string | null; panes?: (string | null)[]; live?: number };

/**
 * An in-memory stand-in for `TabManager`: an ordered tab list with an active
 * tab, each tab owning a fake grid whose `applySnapshot` replaces its snapshot
 * (so a load leaves the tab matching the profile, as the real grid would).
 */
function fakeTabs(specs: TabSpec[] = [{}]): {
  workspace: ProfileWorkspace;
  tabs: FakeTab[];
  active: () => FakeTab;
  activate: (index: number) => void;
  /** Makes every later `applySnapshot` hang on its connects (it applies the
   * layout, then never resolves), as with a pending host-key prompt. */
  holdConnects: () => void;
} {
  const tabs: FakeTab[] = [];
  let connects: Promise<void> = Promise.resolve();
  const makeTab = (spec: TabSpec): FakeTab => {
    const tab = {
      name: spec.name ?? "Tab",
      linked: spec.linked ?? null,
      snap: snapshot(spec.panes ?? [null, null]),
      live: spec.live ?? 0,
    } as FakeTab;
    tab.applySnapshot = vi.fn(async (s: WorkspaceSnapshot) => {
      tab.snap = s;
      await connects;
      return true;
    });
    tab.grid = {
      snapshot: () => tab.snap,
      applySnapshot: tab.applySnapshot,
      liveSessionCount: () => tab.live,
    } as unknown as Grid;
    return tab;
  };
  tabs.push(...specs.map(makeTab));
  let active = tabs[0]!;
  const groupOf = (id: string): FakeTab[] => tabs.filter((t) => t.linked === id);
  const workspace: ProfileWorkspace = {
    activeLinkedProfileId: () => active.linked,
    activeGroupGrids: () =>
      (active.linked === null ? [active] : groupOf(active.linked)).map((t) => t.grid),
    groupGrids: (id) => groupOf(id).map((t) => t.grid),
    linkedProfileIds: () => [...new Set(tabs.flatMap((t) => (t.linked === null ? [] : [t.linked])))],
    activateGrid: (grid) => {
      active = tabs.find((t) => t.grid === grid) ?? active;
    },
    tabSnapshots: (grids) =>
      tabs.filter((t) => grids.includes(t.grid)).map((t) => ({ name: t.name, ...t.snap })),
    linkProfile: (grid, id) => {
      const tab = tabs.find((t) => t.grid === grid);
      if (tab) tab.linked = id;
    },
    refreshTabStrip: () => {},
    clearProfileLink: (id) => {
      for (const tab of groupOf(id)) tab.linked = null;
    },
    openTabs: async (names, linkedProfileId, replacing = []) => {
      const created = names.map((name) => makeTab({ name, linked: linkedProfileId, panes: [null] }));
      const at = tabs.findIndex((t) => replacing.includes(t.grid));
      tabs.splice(at >= 0 ? at : tabs.length, 0, ...created);
      for (let i = tabs.length - 1; i >= 0; i--) {
        if (replacing.includes(tabs[i]!.grid)) tabs.splice(i, 1);
      }
      active = created[0]!;
      return created.map((t) => t.grid);
    },
  };
  return {
    workspace,
    tabs,
    active: () => active,
    activate: (index) => {
      active = tabs[index]!;
    },
    holdConnects: () => {
      connects = new Promise(() => {});
    },
  };
}

function grid1x2(): WorkspaceSnapshot["grid"] {
  return { rows: 1, cols: 2, rowSizes: [1], colSizes: [0.5, 0.5] };
}

function snapshot(panes: (string | null)[]): WorkspaceSnapshot {
  return { grid: grid1x2(), panes };
}

function profileTab(name: string, panes: (string | null)[]): ProfileTab {
  return { name, grid: grid1x2(), panes: panes.map((deviceId) => ({ deviceId })) };
}

/** A one-tab profile "Homelab" (id "p1") whose tab is also named "Homelab". */
function profile(panes: (string | null)[]): Profile {
  return { id: "p1", name: "Homelab", tabs: [profileTab("Homelab", panes)] };
}

/** A two-tab profile "Lab" (id "lab"): tabs "Web" and "DB". */
function labProfile(): Profile {
  return {
    id: "lab",
    name: "Lab",
    tabs: [profileTab("Web", ["web-1", "web-2"]), profileTab("DB", ["db-1", null])],
  };
}

/** The tabs' names and links, in strip order. */
function strip(tabs: FakeTab[]): string[] {
  return tabs.map((t) => `${t.name}:${t.linked ?? "-"}`);
}

/** The loaded profile's status dot shows unsaved changes via the `.dirty`
 * class; absent when no profile is loaded (→ not dirty). */
function dirtyShown(): boolean {
  const d = document.querySelector<HTMLElement>(
    ".profile-item-loaded .profile-status-dot",
  );
  return d !== null && d.classList.contains("dirty");
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function click(selector: string, index = 0): void {
  document.querySelectorAll<HTMLButtonElement>(selector)[index]?.click();
}

/** Clicks the button of the profile item at `index` (sidebar order). */
function clickItem(action: string, index = 0): void {
  click(`.profile-item [data-action="${action}"]`, index);
}

async function answerPrompt(value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(".prompt-dialog .prompt-input");
  if (input) input.value = value;
  click('.prompt-dialog [data-action="ok"]');
  await flush();
}

function newManager(workspace: ProfileWorkspace, extra: Partial<ConstructorParameters<typeof ProfileManager>[0]> = {}): ProfileManager {
  return new ProfileManager({ workspace, onError: vi.fn(), onSuccess: vi.fn(), ...extra });
}

/**
 * Wire the two profile commands to a shared mutable backing store so that a
 * Save is visible to the following `reload()` (as the real backend would be).
 */
function wireStore(initial: Profile[], defaultId: string | null, migratedFromV1 = false): void {
  let backing = initial.map((p) => structuredClone(p));
  let migrated = migratedFromV1;
  vi.mocked(listProfiles).mockImplementation(async () => ({
    defaultProfileId: defaultId,
    profiles: backing.map((p) => structuredClone(p)),
    migratedFromV1: migrated,
  }));
  vi.mocked(saveProfile).mockImplementation(async (p: Profile) => {
    migrated = false; // the backend clears the flag on its next write
    const saved = { ...structuredClone(p), id: p.id || "new-id" };
    const i = backing.findIndex((x) => x.id === saved.id);
    if (i >= 0) backing[i] = saved;
    else backing = [...backing, saved];
    return saved;
  });
}

function lastSaved(): Profile | undefined {
  return vi.mocked(saveProfile).mock.calls.at(-1)?.[0];
}

beforeEach(() => {
  document.body.innerHTML = `
    <div class="profile-list"></div>
  `;
  vi.mocked(listProfiles).mockReset();
  vi.mocked(saveProfile).mockReset();
});

describe("ProfileManager app-start", () => {
  it("loads the default profile on init in place of the blank tab, with no teardown confirm", async () => {
    const ws = fakeTabs();
    wireStore([profile(["dev-1", null])], "p1");

    await newManager(ws.workspace).init(null);
    await flush();

    expect(strip(ws.tabs)).toEqual(["Homelab:p1"]);
    expect(ws.tabs[0]!.applySnapshot).toHaveBeenCalledWith(snapshot(["dev-1", null]), {
      confirmTeardown: false,
    });
    expect(document.querySelector(".confirm-dialog")).toBeNull();
    expect(dirtyShown()).toBe(false);
  });

  it("opens every tab of a multi-tab default profile", async () => {
    const ws = fakeTabs();
    wireStore([labProfile()], "lab");

    await newManager(ws.workspace).init(null);
    await flush();

    expect(strip(ws.tabs)).toEqual(["Web:lab", "DB:lab"]);
    expect(ws.tabs[1]!.snap.panes).toEqual(["db-1", null]);
    expect(ws.active()).toBe(ws.tabs[0]);
    expect(dirtyShown()).toBe(false);
  });

  it("loads the last-used profile when there is no default", async () => {
    const ws = fakeTabs();
    wireStore([profile(["dev-1", null])], null);
    const onProfileChange = vi.fn();

    await newManager(ws.workspace, { onProfileChange }).init("p1");
    await flush();

    expect(strip(ws.tabs)).toEqual(["Homelab:p1"]);
    expect(onProfileChange).toHaveBeenLastCalledWith("p1");
    expect(dirtyShown()).toBe(false);
  });

  it("prefers the default profile over the last-used profile", async () => {
    const ws = fakeTabs();
    wireStore([labProfile(), profile(["dev-1", null])], "lab");

    await newManager(ws.workspace).init("p1"); // last-used points elsewhere, but default wins
    await flush();

    expect(strip(ws.tabs)).toEqual(["Web:lab", "DB:lab"]);
  });

  it("loads nothing when the last-used profile no longer exists", async () => {
    const ws = fakeTabs([{ name: "Tab 1" }]);
    wireStore([profile(["dev-1", null])], null);
    const onProfileChange = vi.fn();

    // Stale id: the profile was deleted in a previous session.
    await newManager(ws.workspace, { onProfileChange }).init("gone");
    await flush();

    expect(strip(ws.tabs)).toEqual(["Tab 1:-"]);
    // Nothing was loaded or saved: no settings write (another running instance
    // would reload everything). A stale id is harmless, never found again.
    expect(onProfileChange).not.toHaveBeenCalled();
    expect(dirtyShown()).toBe(false);
  });

  it("does not report a profile change on a tab switch or a restored start", async () => {
    const ws = fakeTabs([{ name: "Web", linked: "lab" }, { name: "Free" }]);
    wireStore([labProfile()], null);
    const onProfileChange = vi.fn();
    const manager = newManager(ws.workspace, { onProfileChange });
    await manager.init(null, { loadStart: false });

    ws.activate(1);
    manager.onActiveTabChanged();

    expect(onProfileChange).not.toHaveBeenCalled();
  });

  it("does not load anything when the tab set was restored", async () => {
    const ws = fakeTabs([{ name: "Tab 1" }]);
    wireStore([profile(["dev-1", null])], "p1");

    await newManager(ws.workspace).init(null, { loadStart: false });
    await flush();

    expect(strip(ws.tabs)).toEqual(["Tab 1:-"]);
  });
});

describe("ProfileManager load", () => {
  it("replaces the active tab's group, leaving the other tabs in place", async () => {
    const ws = fakeTabs([
      { name: "A", linked: "p1" },
      { name: "Free" },
      { name: "B", linked: "p1" },
    ]);
    wireStore([profile([null, null]), labProfile()], null);
    const mgr = newManager(ws.workspace);
    await mgr.init(null, { loadStart: false });

    clickItem("load", 1); // Lab
    await flush();
    // Two tabs close, so it asks first even with nothing live — and says so.
    expect(document.querySelector(".confirm-dialog")?.textContent).toContain("2 tabs will be closed.");
    click('.confirm-dialog [data-action="confirm"]');
    await flush();

    expect(strip(ws.tabs)).toEqual(["Web:lab", "DB:lab", "Free:-"]);
    expect(ws.active()).toBe(ws.tabs[0]);
  });

  it("does not ask before replacing a single idle tab", async () => {
    const ws = fakeTabs([{ name: "Free" }]);
    wireStore([labProfile()], null);
    await newManager(ws.workspace).init(null, { loadStart: false });

    clickItem("load");
    await flush();

    expect(document.querySelector(".confirm-dialog")).toBeNull();
    expect(strip(ws.tabs)).toEqual(["Web:lab", "DB:lab"]);
  });

  it("switches to a profile already open in other tabs instead of opening it again", async () => {
    const ws = fakeTabs([{ name: "Web", linked: "lab" }, { name: "Free" }]);
    wireStore([labProfile()], null);
    await newManager(ws.workspace).init(null, { loadStart: false });
    ws.activate(1);

    clickItem("load");
    await flush();

    expect(strip(ws.tabs)).toEqual(["Web:lab", "Free:-"]);
    expect(ws.active()).toBe(ws.tabs[0]);
  });

  it("reloads the active tab's own profile in place (revert)", async () => {
    const ws = fakeTabs();
    wireStore([labProfile()], "lab");
    await newManager(ws.workspace).init(null);
    await flush();
    ws.tabs[0]!.snap = snapshot(["edited", null]);

    clickItem("load");
    await flush();
    click('.confirm-dialog [data-action="confirm"]');
    await flush();

    expect(strip(ws.tabs)).toEqual(["Web:lab", "DB:lab"]);
    expect(ws.tabs[0]!.snap.panes).toEqual(["web-1", "web-2"]);
    expect(dirtyShown()).toBe(false);
  });

  it("frees the profile actions without waiting for the panes to connect", async () => {
    const ws = fakeTabs([{ name: "Free" }]);
    wireStore([labProfile()], null);
    await newManager(ws.workspace).init(null, { loadStart: false });
    ws.holdConnects();

    clickItem("load");
    await flush();
    click('[data-action="save"]');
    await flush();

    expect(strip(ws.tabs)).toEqual(["Web:lab", "DB:lab"]);
    expect(dirtyShown()).toBe(false);
    expect(vi.mocked(saveProfile)).toHaveBeenCalledTimes(1);
  });

  it("replaces only the active tab when it is not linked", async () => {
    const ws = fakeTabs([{ name: "Free" }, { name: "Other", linked: "p1" }]);
    wireStore([profile([null, null]), labProfile()], null);
    await newManager(ws.workspace).init(null, { loadStart: false });

    clickItem("load", 1);
    await flush();

    expect(strip(ws.tabs)).toEqual(["Web:lab", "DB:lab", "Other:p1"]);
  });

  it("asks first when the replaced tabs have live sessions, and a cancel changes nothing", async () => {
    const ws = fakeTabs([{ name: "A", linked: "p1", live: 1 }, { name: "B", linked: "p1", live: 2 }]);
    wireStore([profile([null, null]), labProfile()], null);
    await newManager(ws.workspace).init(null, { loadStart: false });

    clickItem("load", 1);
    await flush();
    expect(document.querySelectorAll(".confirm-dialog")).toHaveLength(1);
    click('.confirm-dialog [data-action="cancel"]');
    await flush();

    expect(strip(ws.tabs)).toEqual(["A:p1", "B:p1"]);
  });

  it("replaces the group it was clicked on, even if the user switched tabs during the confirm", async () => {
    const ws = fakeTabs([{ name: "A", live: 1 }, { name: "B" }]);
    wireStore([labProfile()], null);
    await newManager(ws.workspace).init(null, { loadStart: false });

    clickItem("load");
    await flush();
    ws.activate(1); // Ctrl+Tab while the teardown confirm is open
    click('.confirm-dialog [data-action="confirm"]');
    await flush();

    expect(strip(ws.tabs)).toEqual(["Web:lab", "DB:lab", "B:-"]);
  });

  it("Open-in-new-tabs switches to the profile's tabs when it is already open", async () => {
    const ws = fakeTabs([{ name: "Free" }, { name: "Web", linked: "lab" }]);
    wireStore([labProfile()], null);
    await newManager(ws.workspace).init(null, { loadStart: false });

    clickItem("open-tab");
    await flush();

    expect(strip(ws.tabs)).toEqual(["Free:-", "Web:lab"]);
    expect(ws.active()).toBe(ws.tabs[1]);
  });

  it("Open-in-new-tabs appends the profile's tabs, linked, leaving existing tabs", async () => {
    const ws = fakeTabs([{ name: "Tab 1" }]);
    const onSuccess = vi.fn();
    wireStore([labProfile()], null);
    await newManager(ws.workspace, { onSuccess }).init(null);

    clickItem("open-tab");
    await flush();

    expect(strip(ws.tabs)).toEqual(["Tab 1:-", "Web:lab", "DB:lab"]);
    expect(ws.tabs[1]!.applySnapshot).toHaveBeenCalledWith(snapshot(["web-1", "web-2"]), {
      confirmTeardown: false,
    });
    expect(ws.active()).toBe(ws.tabs[1]);
    expect(onSuccess).toHaveBeenCalled();
  });
});

describe("ProfileManager dirty state + save", () => {
  it("shows the dot after an edit and clears it after Save persists the snapshot", async () => {
    const ws = fakeTabs();
    wireStore([profile(["dev-1", null])], "p1");
    const mgr = newManager(ws.workspace);
    await mgr.init(null);
    await flush();
    expect(dirtyShown()).toBe(false);

    // Simulate a workspace edit: the second pane now has a device.
    ws.tabs[0]!.snap = snapshot(["dev-1", "dev-2"]);
    mgr.refreshDirty();
    expect(dirtyShown()).toBe(true);

    click('[data-action="save"]');
    await flush();

    expect(vi.mocked(saveProfile)).toHaveBeenCalledTimes(1);
    expect(lastSaved()?.tabs).toEqual([profileTab("Homelab", ["dev-1", "dev-2"])]);
    expect(dirtyShown()).toBe(false);
  });

  it("Save after a device deletion persists the nulled pane, not the stale id", async () => {
    // The pane already dropped the deleted device from the snapshot (see
    // pane.ts refreshDevices); the manager must persist that null, never
    // resurrect the id.
    const ws = fakeTabs();
    wireStore([profile(["dev-1", "dev-2"])], "p1");
    await newManager(ws.workspace).init(null);
    await flush();

    ws.tabs[0]!.snap = snapshot(["dev-1", null]);
    click('[data-action="save"]');
    await flush();

    expect(lastSaved()?.tabs[0]?.panes).toEqual([{ deviceId: "dev-1" }, { deviceId: null }]);
  });

  it("Save writes every tab linked to the profile, in strip order, and no other tab", async () => {
    const ws = fakeTabs([
      { name: "Web", linked: "lab", panes: ["web-1", "web-2"] },
      { name: "Free", panes: ["x", null] },
      { name: "Logs", linked: "lab", panes: ["log-1", null] },
      { name: "Home", linked: "p1" },
    ]);
    wireStore([labProfile(), profile([null, null])], null);
    await newManager(ws.workspace).init(null, { loadStart: false });

    click('[data-action="save"]');
    await flush();

    expect(lastSaved()).toEqual({
      ...labProfile(),
      tabs: [profileTab("Web", ["web-1", "web-2"]), profileTab("Logs", ["log-1", null])],
    });
  });

  it("is dirty when a tab of the group is closed or renamed", async () => {
    const ws = fakeTabs();
    wireStore([labProfile()], "lab");
    const mgr = newManager(ws.workspace);
    await mgr.init(null);
    await flush();
    expect(dirtyShown()).toBe(false);

    ws.tabs[1]!.name = "Database";
    mgr.refreshDirty();
    expect(dirtyShown()).toBe(true);

    ws.tabs[1]!.name = "DB";
    ws.tabs.splice(1, 1);
    mgr.refreshDirty();
    expect(dirtyShown()).toBe(true);
  });
});

describe("ProfileManager per-tab state", () => {
  it("resolveTabState reports linked + the group's dirty state", async () => {
    const ws = fakeTabs();
    wireStore([labProfile()], "lab");
    const mgr = newManager(ws.workspace);
    await mgr.init(null);
    await flush();

    expect(mgr.resolveTabState("lab")).toEqual({ linked: true, dirty: false });
    // Unknown id (deleted/dangling) → not linked.
    expect(mgr.resolveTabState("gone")).toEqual({ linked: false, dirty: false });
    expect(mgr.resolveTabState(null)).toEqual({ linked: false, dirty: false });
    // An edit in one tab makes the whole group dirty.
    ws.tabs[1]!.snap = snapshot(["db-2", null]);
    expect(mgr.resolveTabState("lab")).toEqual({ linked: true, dirty: true });
  });
});

describe("ProfileManager Save As", () => {
  it("saves and links the active group, even if the user switched tabs during the prompt", async () => {
    const ws = fakeTabs([{ name: "A", panes: ["dev-a", null] }, { name: "B", panes: ["dev-b", null] }]);
    wireStore([], null);
    await newManager(ws.workspace).init(null);

    click('[data-action="save-as"]');
    await flush();
    ws.activate(1);
    await answerPrompt("From A");

    expect(lastSaved()?.tabs).toEqual([profileTab("A", ["dev-a", null])]);
    expect(strip(ws.tabs)).toEqual(["A:new-id", "B:-"]);
  });

  it("saves nothing when every captured tab was closed during the prompt", async () => {
    const ws = fakeTabs([{ name: "A" }, { name: "B" }]);
    wireStore([], null);
    const onError = vi.fn();
    await newManager(ws.workspace, { onError }).init(null);

    click('[data-action="save-as"]');
    await flush();
    ws.tabs.splice(0, 1);
    await answerPrompt("Gone");

    expect(vi.mocked(saveProfile)).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("from a linked tab, saves its whole group as the new profile and relinks it", async () => {
    const ws = fakeTabs([
      { name: "Web", linked: "lab" },
      { name: "Free" },
      { name: "DB", linked: "lab" },
    ]);
    wireStore([labProfile()], null);
    await newManager(ws.workspace).init(null, { loadStart: false });

    click('[data-action="save-as"]');
    await flush();
    await answerPrompt("Lab copy");

    expect(lastSaved()?.tabs.map((t) => t.name)).toEqual(["Web", "DB"]);
    expect(strip(ws.tabs)).toEqual(["Web:new-id", "Free:-", "DB:new-id"]);
  });
});

describe("ProfileManager missing profiles", () => {
  it("unlinks tabs whose profile no longer exists, so they stop acting as a group", async () => {
    const ws = fakeTabs([{ name: "A", linked: "gone" }, { name: "B", linked: "gone" }]);
    wireStore([labProfile()], null);
    const onProfileChange = vi.fn();
    await newManager(ws.workspace, { onProfileChange }).init(null, { loadStart: false });

    expect(strip(ws.tabs)).toEqual(["A:-", "B:-"]);
    // Another instance deleted it; reacting with a settings write would ping
    // that instance back.
    expect(onProfileChange).not.toHaveBeenCalled();
  });

  it("keeps the links when the profile list fails to load", async () => {
    const ws = fakeTabs([{ name: "A", linked: "p1" }]);
    vi.mocked(listProfiles).mockRejectedValue(new Error("io"));
    await newManager(ws.workspace).init(null, { loadStart: false });

    expect(strip(ws.tabs)).toEqual(["A:p1"]);
  });
});

describe("ProfileManager v1 upgrade", () => {
  it("renames each converted profile's tab after its open tab and unlinks extra copies", async () => {
    const ws = fakeTabs([
      { name: "Tab 1", linked: "p1", panes: ["dev-1", null] },
      { name: "Tab 2", linked: "p1", panes: ["dev-1", null] },
    ]);
    wireStore([profile(["dev-1", null])], null, true);

    await newManager(ws.workspace).init(null, { loadStart: false });
    await flush();

    expect(lastSaved()?.tabs).toEqual([profileTab("Tab 1", ["dev-1", null])]);
    expect(strip(ws.tabs)).toEqual(["Tab 1:p1", "Tab 2:-"]);
    expect(dirtyShown()).toBe(false);
  });

  it("saves nothing when the open tab already has the profile's name", async () => {
    const ws = fakeTabs([{ name: "Homelab", linked: "p1" }]);
    wireStore([profile([null, null])], null, true);

    await newManager(ws.workspace).init(null, { loadStart: false });

    expect(vi.mocked(saveProfile)).not.toHaveBeenCalled();
  });

  it("does nothing on a launch that converted nothing", async () => {
    const ws = fakeTabs([{ name: "Tab 1", linked: "p1" }, { name: "Tab 2", linked: "p1" }]);
    wireStore([profile([null, null])], null);

    await newManager(ws.workspace).init(null, { loadStart: false });

    expect(vi.mocked(saveProfile)).not.toHaveBeenCalled();
    expect(strip(ws.tabs)).toEqual(["Tab 1:p1", "Tab 2:p1"]);
  });
});

describe("ProfileManager rename", () => {
  it("renames the profile without linking the active tab to it", async () => {
    const ws = fakeTabs([{ name: "Free" }]);
    wireStore([labProfile()], null);
    await newManager(ws.workspace).init(null, { loadStart: false });

    clickItem("rename");
    await flush();
    await answerPrompt("Lab 2");

    expect(lastSaved()).toEqual({ ...labProfile(), name: "Lab 2" });
    expect(strip(ws.tabs)).toEqual(["Free:-"]);
  });
});

describe("ProfileManager busy guard (F12)", () => {
  it("does not open a profile's tabs twice on a rapid double click of Load", async () => {
    const ws = fakeTabs([{ name: "A", live: 1 }]);
    wireStore([labProfile()], null);
    await newManager(ws.workspace).init(null, { loadStart: false });

    clickItem("load");
    clickItem("load");
    await flush();
    expect(document.querySelectorAll(".confirm-dialog")).toHaveLength(1);
    click('.confirm-dialog [data-action="confirm"]');
    await flush();

    expect(strip(ws.tabs)).toEqual(["Web:lab", "DB:lab"]);
  });

  it("does not open two Save As prompts on a rapid double click", async () => {
    vi.mocked(listProfiles).mockResolvedValue({ defaultProfileId: null, profiles: [], migratedFromV1: false });

    await newManager(fakeTabs().workspace).init(null);
    await flush();

    const btn = document.querySelector<HTMLButtonElement>('[data-action="save-as"]');
    btn?.click();
    btn?.click();

    // Only one `prompt()` dialog reached the DOM — the second click was
    // swallowed by the busy guard before it could open another.
    expect(document.querySelectorAll(".prompt-dialog").length).toBe(1);

    // Clean up the still-open prompt so it doesn't leak into later tests.
    document
      .querySelector<HTMLButtonElement>('.prompt-dialog [data-action="cancel"]')
      ?.click();
    await flush();
  });

  it("does not persist twice when Save is double-clicked while a profile is loaded", async () => {
    vi.mocked(listProfiles).mockResolvedValue({
      defaultProfileId: "p1",
      profiles: [profile(["dev-1", null])],
      migratedFromV1: false,
    });
    let resolveSave: (p: Profile) => void = () => {};
    vi.mocked(saveProfile).mockImplementation(
      () =>
        new Promise<Profile>((resolve) => {
          resolveSave = resolve;
        }),
    );

    await newManager(fakeTabs().workspace).init(null);
    await flush();

    const btn = document.querySelector<HTMLButtonElement>('[data-action="save"]');
    btn?.click();
    btn?.click();
    await flush();

    // The first click's `saveProfile` call is still pending; the second
    // click must have been blocked by the guard, not queued a second call.
    expect(vi.mocked(saveProfile)).toHaveBeenCalledTimes(1);

    resolveSave(profile(["dev-1", null]));
    await flush();
  });
});

describe("ProfileManager import/export", () => {
  const JSON_FILTER = { name: "JSON", extensions: ["json"] };

  beforeEach(() => {
    saveMock.mockReset();
    openMock.mockReset();
    vi.mocked(exportProfiles).mockReset();
    vi.mocked(importProfiles).mockReset();
    vi.mocked(listProfiles).mockResolvedValue({
      defaultProfileId: null,
      profiles: [profile(["dev-1", null])],
      migratedFromV1: false,
    });
  });

  async function initManager(): Promise<ProfileManager> {
    const mgr = newManager(fakeTabs().workspace);
    await mgr.init(null);
    await flush();
    return mgr;
  }

  it("puts Export/Import in the header beside Save/Save As as icon buttons", async () => {
    await initManager();
    expect(document.querySelector(".section-actions")).toBeNull();
    const actions = document.querySelectorAll<HTMLButtonElement>(".profile-header-actions .btn");
    expect(actions).toHaveLength(4);
    expect(actions[0]!.classList.contains("profile-export-btn")).toBe(true);
    expect(actions[1]!.classList.contains("profile-import-btn")).toBe(true);
    for (const btn of actions) {
      expect(btn.classList.contains("btn-icon")).toBe(true);
      expect(btn.querySelector("svg")).not.toBeNull();
      expect(btn.textContent!.trim()).toBe("");
      expect(btn.title).not.toBe("");
      expect(btn.getAttribute("aria-label")).not.toBe("");
    }
  });

  it("Export click picks a save path then calls exportProfiles with it", async () => {
    saveMock.mockResolvedValue("C:/out/dasshboard-profiles.json");
    vi.mocked(exportProfiles).mockResolvedValue(1);
    await initManager();

    document
      .querySelector<HTMLButtonElement>(".profile-export-btn")
      ?.click();
    await flush();

    expect(saveMock).toHaveBeenCalledWith({
      defaultPath: "dasshboard-profiles.json",
      filters: [JSON_FILTER],
    });
    expect(vi.mocked(exportProfiles)).toHaveBeenCalledWith(
      "C:/out/dasshboard-profiles.json",
    );
  });

  it("a cancelled save dialog does not call exportProfiles", async () => {
    saveMock.mockResolvedValue(null);
    await initManager();

    document
      .querySelector<HTMLButtonElement>(".profile-export-btn")
      ?.click();
    await flush();

    expect(vi.mocked(exportProfiles)).not.toHaveBeenCalled();
  });

  it("Import click opens a file then calls importProfiles and reloads", async () => {
    openMock.mockResolvedValue("C:/in/dasshboard-profiles.json");
    vi.mocked(importProfiles).mockResolvedValue(2);
    await initManager();
    // One listProfiles from init(); the reload after import makes it two.
    expect(vi.mocked(listProfiles)).toHaveBeenCalledTimes(1);

    document
      .querySelector<HTMLButtonElement>(".profile-import-btn")
      ?.click();
    await flush();

    expect(openMock).toHaveBeenCalledWith({
      multiple: false,
      filters: [JSON_FILTER],
    });
    expect(vi.mocked(importProfiles)).toHaveBeenCalledWith(
      "C:/in/dasshboard-profiles.json",
    );
    expect(vi.mocked(listProfiles)).toHaveBeenCalledTimes(2);
  });

  it("a cancelled open dialog does not call importProfiles or reload", async () => {
    openMock.mockResolvedValue(null);
    await initManager();

    document
      .querySelector<HTMLButtonElement>(".profile-import-btn")
      ?.click();
    await flush();

    expect(vi.mocked(importProfiles)).not.toHaveBeenCalled();
    expect(vi.mocked(listProfiles)).toHaveBeenCalledTimes(1);
  });
});
