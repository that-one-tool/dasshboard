/**
 * @vitest-environment happy-dom
 *
 * Unit tests for `TabManager` (Tabs milestone, Phase 1). The `Grid` collaborator
 * is mocked with a lightweight fake that records the calls the tab lifecycle
 * depends on (`init`/`refit`/`focus`/`dispose`/`liveSessionCount`), so these
 * tests exercise tab creation, activation (show/hide + refit), closing (with the
 * live-session confirm), and the "never leave zero tabs" rule — without a real
 * grid or backend.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

interface FakeGrid {
  root: HTMLElement;
  live: number;
  init: Mock;
  refit: Mock;
  focus: Mock;
  dispose: Mock;
  refreshDevices: Mock;
  retranslate: Mock;
  applyTerminalSettings: Mock;
  liveSessionCount: Mock;
  snapshot: Mock;
  applySnapshot: Mock;
}

// `vi.mock` is hoisted above the file, so the fake Grid and the instance registry
// it writes to must be created in a `vi.hoisted` block (referencing a top-level
// class here would hit the TDZ).
const { gridInstances, FakeGridClass, initGate } = vi.hoisted(() => {
  const gridInstances: FakeGrid[] = [];
  /** While `promise` is set, every new grid's `init()` waits on it — to act on
   * the tab set while a tab is still being created. */
  const initGate: { promise: Promise<void> | null } = { promise: null };
  class FakeGridClass {
    root: HTMLElement;
    live = 0;
    init = vi.fn(async () => {
      await initGate.promise;
    });
    refit = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    refreshDevices = vi.fn(async () => {});
    retranslate = vi.fn();
    applyTerminalSettings = vi.fn();
    liveSessionCount = vi.fn(function (this: FakeGrid) {
      return this.live;
    });
    snapshot = vi.fn(() => ({
      grid: { rows: 1, cols: 1, rowSizes: [1], colSizes: [1] },
      panes: [null],
    }));
    applySnapshot = vi.fn(async () => true);
    constructor(root: HTMLElement) {
      this.root = root;
      gridInstances.push(this as unknown as FakeGrid);
    }
  }
  return { gridInstances, FakeGridClass, initGate };
});

vi.mock("../grid", () => ({ Grid: FakeGridClass }));

// The close-with-live-sessions confirm; default to "confirmed".
const confirmMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../ui/confirm", () => ({ confirm: confirmMock }));

import { TabManager, type TabManagerOptions } from "./tabManager";
import type { WorkspaceState } from "../ipc";
import type { Grid } from "../grid";
import { setLocale } from "../i18n";

function makeManager(extra: Partial<Omit<TabManagerOptions, "grid">> = {}): TabManager {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return new TabManager(root, {
    grid: { onError: vi.fn(), onChange: vi.fn(), getTerminalSettings: vi.fn() },
    ...extra,
  });
}

/** A fake grid, typed as the real `Grid` the manager's methods take. */
function asGrid(fake: FakeGrid | undefined): Grid {
  return fake as unknown as Grid;
}

function tabNames(): (string | null | undefined)[] {
  return tabButtons().map((b) => b.querySelector(".tab-name")?.textContent);
}

function tabButtons(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".tab"));
}

function panels(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".tab-panel"));
}

beforeEach(() => {
  document.body.innerHTML = "";
  gridInstances.length = 0;
  initGate.promise = null;
  confirmMock.mockClear();
  confirmMock.mockResolvedValue(true);
});

describe("TabManager.init", () => {
  it("opens exactly one blank tab and activates it", async () => {
    const tm = makeManager();
    await tm.init();

    expect(gridInstances).toHaveLength(1);
    expect(gridInstances[0]?.init).toHaveBeenCalledOnce();
    expect(tabButtons()).toHaveLength(1);
    expect(tabButtons()[0]?.classList.contains("tab-active")).toBe(true);
    expect(panels()[0]?.classList.contains("tab-hidden")).toBe(false);
    // Activation refits + focuses the now-visible grid.
    expect(gridInstances[0]?.refit).toHaveBeenCalled();
    expect(gridInstances[0]?.focus).toHaveBeenCalled();
  });
});

describe("TabManager keyboard shortcuts", () => {
  const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

  function press(init: KeyboardEventInit): void {
    window.dispatchEvent(new KeyboardEvent("keydown", init));
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens a tab on Ctrl+Shift+T", async () => {
    const tm = makeManager();
    await tm.init();
    press({ key: "T", shiftKey: true, ctrlKey: true });
    await vi.waitFor(() => expect(tabButtons()).toHaveLength(2));
    tm.dispose();
  });

  it("opens a tab on Cmd+Shift+T on macOS", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(MAC_UA);
    const tm = makeManager();
    await tm.init();
    press({ key: "T", shiftKey: true, metaKey: true });
    await vi.waitFor(() => expect(tabButtons()).toHaveLength(2));
    tm.dispose();
  });

  it("closes the active tab on Cmd+W on macOS", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(MAC_UA);
    const tm = makeManager();
    await tm.init();
    await tm.newTab();
    press({ key: "w", metaKey: true });
    await vi.waitFor(() => expect(tabButtons()).toHaveLength(1));
    tm.dispose();
  });
});

describe("TabManager.newTab", () => {
  it("adds a tab, activates it, and hides the previous one", async () => {
    const tm = makeManager();
    await tm.init();
    await tm.newTab();

    expect(gridInstances).toHaveLength(2);
    expect(tabButtons()).toHaveLength(2);
    // Only the second tab is active/visible now.
    expect(panels()[0]?.classList.contains("tab-hidden")).toBe(true);
    expect(panels()[1]?.classList.contains("tab-hidden")).toBe(false);
    expect(tm.activeGrid()).toBe(gridInstances[1]);
  });
});

describe("TabManager.activate", () => {
  it("shows the target, hides the rest, and refits the shown grid", async () => {
    const tm = makeManager();
    await tm.init();
    await tm.newTab(); // now on tab 1
    gridInstances[0]?.refit.mockClear();

    tm.activate(0);

    expect(panels()[0]?.classList.contains("tab-hidden")).toBe(false);
    expect(panels()[1]?.classList.contains("tab-hidden")).toBe(true);
    expect(gridInstances[0]?.refit).toHaveBeenCalled();
    expect(tm.activeGrid()).toBe(gridInstances[0]);
  });
});

describe("TabManager.closeTab", () => {
  it("disposes the grid and removes its DOM", async () => {
    const tm = makeManager();
    await tm.init();
    await tm.newTab();

    const doomed = gridInstances[1];
    await tm.closeTab(1);

    expect(doomed?.dispose).toHaveBeenCalledOnce();
    expect(tabButtons()).toHaveLength(1);
    expect(panels()).toHaveLength(1);
  });

  it("confirms before closing a tab with live sessions and aborts on cancel", async () => {
    const tm = makeManager();
    await tm.init();
    await tm.newTab();
    if (gridInstances[1]) gridInstances[1].live = 2;
    confirmMock.mockResolvedValueOnce(false);

    await tm.closeTab(1);

    expect(confirmMock).toHaveBeenCalledOnce();
    expect(gridInstances[1]?.dispose).not.toHaveBeenCalled();
    expect(tabButtons()).toHaveLength(2);
  });

  it("a second close of a tab awaiting its confirm never closes another tab", async () => {
    const tm = makeManager();
    await tm.init();
    await tm.newTab();
    tm.activate(0);
    if (gridInstances[0]) gridInstances[0].live = 1;
    let accept: (ok: boolean) => void = () => {};
    confirmMock.mockImplementation(() => new Promise<boolean>((resolve) => (accept = resolve)));

    const first = tm.closeTab(0);
    const second = tm.closeTab(0); // e.g. the shortcut pressed twice
    accept(true);
    await Promise.all([first, second]);

    expect(confirmMock).toHaveBeenCalledOnce();
    expect(gridInstances[1]?.dispose).not.toHaveBeenCalled();
    expect(tabButtons()).toHaveLength(1);
    expect(tm.activeGrid()).toBe(gridInstances[1]);
  });

  it("closes the confirmed tab even if the tabs shifted during the confirm", async () => {
    const tm = makeManager();
    await tm.init();
    await tm.newTab();
    await tm.newTab(); // tabs [0, 1, 2]
    if (gridInstances[2]) gridInstances[2].live = 1;
    let accept: (ok: boolean) => void = () => {};
    confirmMock.mockImplementationOnce(() => new Promise<boolean>((resolve) => (accept = resolve)));

    const closing = tm.closeTab(2);
    await tm.closeTab(0); // tab 2 shifts to index 1 meanwhile
    accept(true);
    await closing;

    expect(gridInstances[2]?.dispose).toHaveBeenCalledOnce();
    expect(gridInstances[1]?.dispose).not.toHaveBeenCalled();
    expect(tm.activeGrid()).toBe(gridInstances[1]);
  });

  it("closing a background tab keeps the active tab active", async () => {
    const tm = makeManager();
    await tm.init();
    await tm.newTab();
    await tm.newTab(); // tab 2 active

    await tm.closeTab(0);

    expect(tm.activeGrid()).toBe(gridInstances[2]);
    expect(tm.serialize().activeIndex).toBe(1);
  });

  it("never leaves zero tabs — closing the last opens a fresh blank one", async () => {
    const tm = makeManager();
    await tm.init();

    await tm.closeTab(0);

    expect(gridInstances[0]?.dispose).toHaveBeenCalledOnce();
    expect(tabButtons()).toHaveLength(1);
    expect(gridInstances).toHaveLength(2); // the replacement blank tab
  });
});

describe("TabManager rename (double-click)", () => {
  function startEditing(button: HTMLElement): HTMLInputElement {
    button.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = button.querySelector<HTMLInputElement>(".tab-rename-input");
    if (!input) throw new Error("rename input did not appear");
    return input;
  }

  it("commits a new name on Enter", async () => {
    const tm = makeManager();
    await tm.init();
    const button = tabButtons()[0]!;

    const input = startEditing(button);
    input.value = "web servers";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(button.querySelector(".tab-rename-input")).toBeNull();
    expect(button.querySelector(".tab-name")?.textContent).toBe("web servers");
  });

  it("cancels on Escape, keeping the old name", async () => {
    const tm = makeManager();
    await tm.init();
    const button = tabButtons()[0]!;
    const original = button.querySelector(".tab-name")?.textContent;

    const input = startEditing(button);
    input.value = "discarded";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(button.querySelector(".tab-rename-input")).toBeNull();
    expect(button.querySelector(".tab-name")?.textContent).toBe(original);
  });

  it("ignores an empty/whitespace name", async () => {
    const tm = makeManager();
    await tm.init();
    const button = tabButtons()[0]!;
    const original = button.querySelector(".tab-name")?.textContent;

    const input = startEditing(button);
    input.value = "   ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(button.querySelector(".tab-name")?.textContent).toBe(original);
  });
});

describe("TabManager profile strip (Phase 2)", () => {
  function badge(button: HTMLElement): HTMLElement {
    return button.querySelector<HTMLElement>(".tab-badge")!;
  }
  function dirtyDot(button: HTMLElement): HTMLElement {
    return button.querySelector<HTMLElement>(".tab-dirty-dot")!;
  }

  it("hides badge + dot for an unlinked tab", async () => {
    const tm = makeManager({ resolveTabState: () => ({ linked: false, dirty: false }) });
    await tm.init();
    const btn = tabButtons()[0]!;
    expect(badge(btn).hidden).toBe(true);
    expect(dirtyDot(btn).hidden).toBe(true);
  });

  it("openTabs creates named, linked tabs and shows badge + dot per resolveTabState", async () => {
    const tm = makeManager({
      resolveTabState: (id) => ({ linked: id !== null, dirty: id !== null }),
    });
    await tm.init();
    await tm.openTabs(["Web", "DB"], "p1");

    expect(tabNames()).toEqual(["Tab 1", "Web", "DB"]);
    for (const btn of tabButtons().slice(1)) {
      expect(badge(btn).hidden).toBe(false);
      expect(dirtyDot(btn).hidden).toBe(false);
    }
    expect(tm.activeLinkedProfileId()).toBe("p1");
  });

  it("setLinkedProfileId links the tab owning a grid, not the active one", async () => {
    const tm = makeManager();
    await tm.init();
    await tm.newTab(); // tab 1 active
    const background = asGrid(gridInstances[0]);

    tm.setLinkedProfileId(background, "p1");

    expect(tm.groupGrids("p1")).toEqual([background]);
    expect(tm.activeLinkedProfileId()).toBeNull();
  });

  it("setLinkedProfileId is a no-op for a closed tab's grid", async () => {
    const tm = makeManager();
    await tm.init();
    await tm.newTab();
    const closed = asGrid(gridInstances[1]);
    await tm.closeTab(1);

    tm.setLinkedProfileId(closed, "p1");
    expect(tm.activeLinkedProfileId()).toBeNull();
  });

  it("setLinkedProfileId on the active grid links the active tab and refreshes its badge", async () => {
    const tm = makeManager({ resolveTabState: (id) => ({ linked: id !== null, dirty: false }) });
    await tm.init();
    expect(badge(tabButtons()[0]!).hidden).toBe(true);

    tm.setLinkedProfileId(tm.activeGrid(), "p1");

    expect(tm.activeLinkedProfileId()).toBe("p1");
    expect(badge(tabButtons()[0]!).hidden).toBe(false);
  });

  it("fires onActiveTabChange when the active tab changes", async () => {
    const onActiveTabChange = vi.fn();
    const tm = makeManager({ onActiveTabChange });
    await tm.init();
    onActiveTabChange.mockClear();

    await tm.newTab(); // activates the new tab
    tm.activate(0); // switch back

    expect(onActiveTabChange).toHaveBeenCalledTimes(2);
  });
});

describe("TabManager persistence (Phase 3)", () => {
  const savedGrid = { rows: 1, cols: 1, rowSizes: [1], colSizes: [1] };

  function state(): WorkspaceState {
    return {
      tabs: [
        { name: "web", grid: savedGrid, panes: [{ deviceId: "d1" }], linkedProfileId: "p1" },
        { name: "db", grid: savedGrid, panes: [{ deviceId: null }], linkedProfileId: null },
      ],
      activeIndex: 1,
    };
  }

  it("restores saved tabs, applies their snapshots, and activates the saved index", async () => {
    const tm = makeManager();
    await tm.init(state());

    expect(gridInstances).toHaveLength(2);
    expect(tabButtons().map((b) => b.querySelector(".tab-name")?.textContent)).toEqual([
      "web",
      "db",
    ]);
    // Each grid had its saved snapshot applied (device ids row-major, no confirm).
    expect(gridInstances[0]?.applySnapshot).toHaveBeenCalledWith(
      { grid: savedGrid, panes: ["d1"] },
      { confirmTeardown: false },
    );
    // Saved active index wins.
    expect(panels()[1]?.classList.contains("tab-hidden")).toBe(false);
    expect(tm.activeLinkedProfileId()).toBeNull(); // "db" tab, unlinked
  });

  it("falls back to one blank tab when the saved state is empty", async () => {
    const tm = makeManager();
    await tm.init({ tabs: [], activeIndex: 0 });
    expect(gridInstances).toHaveLength(1);
    expect(tabButtons()).toHaveLength(1);
  });

  it("serialize() captures name, panes, link, and active index", async () => {
    const tm = makeManager();
    await tm.init();
    await tm.newTab();
    tm.setLinkedProfileId(tm.activeGrid(), "p9");

    const s = tm.serialize();
    expect(s.tabs).toHaveLength(2);
    expect(s.activeIndex).toBe(1);
    expect(s.tabs[1]?.linkedProfileId).toBe("p9");
    expect(s.tabs[1]?.panes).toEqual([{ deviceId: null }]); // from the fake snapshot
  });

  it("serialize() includes the left menu width once it has been resized", async () => {
    const tm = makeManager({ getSidebarWidth: () => 360 });
    await tm.init();
    expect(tm.serialize().sidebarWidth).toBe(360);

    const untouched = makeManager({ getSidebarWidth: () => undefined });
    await untouched.init();
    expect(untouched.serialize().sidebarWidth).toBeUndefined();
  });

  it("serialize() includes the device list's collapsed tag sections", async () => {
    const tm = makeManager({ getCollapsedDeviceGroups: () => ["", "web"] });
    await tm.init();
    expect(tm.serialize().collapsedDeviceGroups).toEqual(["", "web"]);
  });

  it("serialize() includes the tunnels' remembered run state", async () => {
    const tm = makeManager({ getTunnelState: () => ({ "dev-1": false }) });
    await tm.init();
    expect(tm.serialize().tunnels).toEqual({ "dev-1": false });
  });

  it("does not persist during init/restore, then persists (debounced) on a change", async () => {
    vi.useFakeTimers();
    try {
      const persist = vi.fn();
      const tm = makeManager({ persist });
      await tm.init(state());
      // Nothing scheduled during restore.
      vi.advanceTimersByTime(1000);
      expect(persist).not.toHaveBeenCalled();

      tm.setLinkedProfileId(tm.activeGrid(), "p2"); // a real change → schedules a save
      expect(persist).not.toHaveBeenCalled(); // still debounced
      vi.advanceTimersByTime(600);
      expect(persist).toHaveBeenCalledTimes(1);
      expect(persist.mock.calls[0]?.[0].tabs).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TabManager review fixes (1-5)", () => {
  it("clearProfileLink unlinks every matching tab, not just the active one", async () => {
    const tm = makeManager({ resolveTabState: (id) => ({ linked: id !== null, dirty: false }) });
    await tm.init();
    tm.setLinkedProfileId(tm.activeGrid(), "p1"); // tab 0 → p1
    await tm.newTab();
    tm.setLinkedProfileId(tm.activeGrid(), "p1"); // tab 1 → p1 (now active)

    tm.clearProfileLink("p1");

    expect(tm.activeLinkedProfileId()).toBeNull(); // background... and active
    tm.activate(0);
    expect(tm.activeLinkedProfileId()).toBeNull(); // ...both cleared
  });

  it("flushPersist writes immediately, and beforeunload flushes a pending save", async () => {
    vi.useFakeTimers();
    try {
      const persist = vi.fn();
      const tm = makeManager({ persist });
      await tm.init();

      tm.setLinkedProfileId(tm.activeGrid(), "p1"); // schedules a debounced save
      tm.flushPersist();
      expect(persist).toHaveBeenCalledTimes(1); // fired without waiting the debounce

      tm.setLinkedProfileId(tm.activeGrid(), "p2");
      window.dispatchEvent(new Event("beforeunload"));
      expect(persist).toHaveBeenCalledTimes(2);

      // Nothing left pending after a flush.
      persist.mockClear();
      vi.advanceTimersByTime(1000);
      expect(persist).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retranslate refreshes the strip chrome to the current locale", async () => {
    const tm = makeManager();
    await tm.init();
    const closeEn = tabButtons()[0]!.querySelector<HTMLElement>(".tab-close")!.title;

    setLocale("fr");
    try {
      tm.retranslate();
      const closeFr = tabButtons()[0]!.querySelector<HTMLElement>(".tab-close")!.title;
      expect(closeFr).not.toBe(closeEn);
      expect(closeFr).toBe("Fermer l'onglet");
    } finally {
      setLocale("en");
    }
  });
});

describe("TabManager profile groups", () => {
  async function linkedTabs(links: (string | null)[]): Promise<TabManager> {
    const tm = makeManager();
    await tm.init();
    for (let i = 1; i < links.length; i++) await tm.newTab();
    links.forEach((id, i) => tm.setLinkedProfileId(asGrid(gridInstances[i]), id));
    return tm;
  }

  it("openTabs returns the new grids in order and activates the first", async () => {
    const tm = makeManager();
    await tm.init();

    const grids = await tm.openTabs(["Web", "DB"], "p1");

    expect(grids).toEqual([asGrid(gridInstances[1]), asGrid(gridInstances[2])]);
    expect(tm.activeGrid()).toBe(grids[0]);
  });

  it("openTabs puts the new tabs where the replaced ones were and disposes those", async () => {
    const tm = await linkedTabs(["p1", null, "p1"]);
    const [a, free, b] = [gridInstances[0], gridInstances[1], gridInstances[2]];

    await tm.openTabs(["Web", "DB"], "lab", [asGrid(a), asGrid(b)]);

    expect(tabNames()).toEqual(["Web", "DB", "Tab 2"]);
    expect(a?.dispose).toHaveBeenCalled();
    expect(b?.dispose).toHaveBeenCalled();
    expect(free?.dispose).not.toHaveBeenCalled();
    expect(tm.activeGrid()).toBe(asGrid(gridInstances[3]));
    expect(tm.activeLinkedProfileId()).toBe("lab");
  });

  it("openTabs replacing the only tab never leaves a blank tab behind", async () => {
    const tm = makeManager();
    await tm.init();

    await tm.openTabs(["Web"], "p1", [tm.activeGrid()]);

    expect(tabNames()).toEqual(["Web"]);
  });

  it("openTabs appends when every replaced tab was closed meanwhile", async () => {
    const tm = makeManager();
    await tm.init();
    await tm.newTab();
    const closed = asGrid(gridInstances[1]);
    await tm.closeTab(1);

    await tm.openTabs(["Web"], "p1", [closed]);

    expect(tabNames()).toEqual(["Tab 1", "Web"]);
  });

  /** Holds every new grid's `init()` until the returned release is called. */
  function holdGridInit(): () => void {
    let release: () => void = () => {};
    initGate.promise = new Promise((resolve) => (release = resolve));
    return () => {
      initGate.promise = null;
      release();
    };
  }

  it("openTabs leaves alone a replaced tab the user closed while it ran", async () => {
    const tm = await linkedTabs(["p1", null, "p1"]);
    tm.activate(0);
    const [a, free, c] = [gridInstances[0], gridInstances[1], gridInstances[2]];
    const release = holdGridInit();

    const opening = tm.openTabs(["Web"], "lab", [asGrid(a), asGrid(c)]);
    await tm.closeTab(2); // Ctrl+W on C while the new tab is still initializing
    release();
    await opening;

    expect(tabNames()).toEqual(["Web", "Tab 2"]);
    expect(tm.serialize().tabs.map((t) => t.name)).toEqual(["Web", "Tab 2"]);
    expect(c?.dispose).toHaveBeenCalledTimes(1);
    expect(free?.dispose).not.toHaveBeenCalled();
  });

  it("openTabs still opens every tab when the tab it was to replace closes while it ran", async () => {
    const tm = makeManager();
    await tm.init();
    await tm.newTab();
    tm.activate(0);
    const release = holdGridInit();

    const opening = tm.openTabs(["Web", "DB"], "lab", [tm.activeGrid()]);
    await tm.closeTab(0);
    release();
    const grids = await opening;

    expect(tabNames()).toEqual(["Tab 2", "Web", "DB"]);
    expect(tm.serialize().tabs.map((t) => t.name)).toEqual(["Tab 2", "Web", "DB"]);
    expect(tm.activeGrid()).toBe(grids[0]);
  });

  it("activateGrid shows the tab owning a grid", async () => {
    const tm = await linkedTabs([null, null]);
    tm.activateGrid(asGrid(gridInstances[0]));
    expect(tm.activeGrid()).toBe(asGrid(gridInstances[0]));
  });

  it("linkedProfileIds lists each linked profile once", async () => {
    const tm = await linkedTabs(["p1", null, "p2", "p1"]);
    expect(tm.linkedProfileIds()).toEqual(["p1", "p2"]);
  });

  it("groupGrids lists a profile's tabs in strip order", async () => {
    const tm = await linkedTabs(["p1", "p2", "p1"]);
    expect(tm.groupGrids("p1")).toEqual([asGrid(gridInstances[0]), asGrid(gridInstances[2])]);
  });

  it("activeGroupGrids is the active tab's profile group, or the active tab alone when unlinked", async () => {
    const tm = await linkedTabs(["p1", null, "p1"]);
    tm.activate(2);
    expect(tm.activeGroupGrids()).toEqual([asGrid(gridInstances[0]), asGrid(gridInstances[2])]);
    tm.activate(1);
    expect(tm.activeGroupGrids()).toEqual([asGrid(gridInstances[1])]);
  });

  it("tabSnapshots gives each still-open tab's name + workspace in strip order", async () => {
    const tm = await linkedTabs([null, null]);
    const grids = [asGrid(gridInstances[1]), asGrid(gridInstances[0])];

    expect(tm.tabSnapshots(grids).map((t) => t.name)).toEqual(["Tab 1", "Tab 2"]);
    expect(tm.tabSnapshots(grids)[0]).toMatchObject({ panes: [null] });
    await tm.closeTab(0);
    expect(tm.tabSnapshots(grids).map((t) => t.name)).toEqual(["Tab 2"]);
  });

  it("a new tab joins the active tab's profile", async () => {
    const tm = makeManager();
    await tm.init();
    await tm.openTabs(["Web"], "p1");

    await tm.newTab();

    expect(tm.activeLinkedProfileId()).toBe("p1");
    expect(tm.groupGrids("p1")).toHaveLength(2);
  });

  it("a new tab opened from an unlinked tab stays unlinked", async () => {
    const tm = makeManager();
    await tm.init();
    await tm.newTab();
    expect(tm.activeLinkedProfileId()).toBeNull();
  });

  it("renaming a tab or closing a background one reports a workspace change", async () => {
    const onChange = vi.fn();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const tm = new TabManager(root, {
      grid: { onError: vi.fn(), onChange, getTerminalSettings: vi.fn() },
    });
    await tm.init();
    await tm.newTab();
    onChange.mockClear();

    tabButtons()[1]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = document.querySelector<HTMLInputElement>(".tab-rename-input")!;
    input.value = "Logs";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onChange).toHaveBeenCalledTimes(1);

    await tm.closeTab(0);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe("TabManager.forEachGrid / mapGrids", () => {
  it("fans an action across every tab's grid", async () => {
    const tm = makeManager();
    await tm.init();
    await tm.newTab();

    tm.forEachGrid((g) => g.retranslate());

    expect(gridInstances[0]?.retranslate).toHaveBeenCalledOnce();
    expect(gridInstances[1]?.retranslate).toHaveBeenCalledOnce();
    expect(tm.mapGrids((g) => g)).toHaveLength(2);
  });
});
