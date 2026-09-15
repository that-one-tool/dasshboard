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

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

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
const { gridInstances, FakeGridClass } = vi.hoisted(() => {
  const gridInstances: FakeGrid[] = [];
  class FakeGridClass {
    root: HTMLElement;
    live = 0;
    init = vi.fn(async () => {});
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
  return { gridInstances, FakeGridClass };
});

vi.mock("../grid", () => ({ Grid: FakeGridClass }));

// The close-with-live-sessions confirm; default to "confirmed".
const confirmMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../ui/confirm", () => ({ confirm: confirmMock }));

import { TabManager, type TabManagerOptions } from "./tabManager";
import type { WorkspaceState } from "../ipc";
import { setLocale } from "../i18n";

function makeManager(extra: Partial<Omit<TabManagerOptions, "grid">> = {}): TabManager {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return new TabManager(root, {
    grid: { onError: vi.fn(), onChange: vi.fn(), getTerminalSettings: vi.fn() },
    ...extra,
  });
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

  it("openTab creates a named, linked tab and shows badge + dot per resolveTabState", async () => {
    const tm = makeManager({
      resolveTabState: (id) => ({ linked: id !== null, dirty: id !== null }),
    });
    await tm.init();
    await tm.openTab({ name: "Homelab", linkedProfileId: "p1" });

    const btn = tabButtons()[1]!;
    expect(btn.querySelector(".tab-name")?.textContent).toBe("Homelab");
    expect(badge(btn).hidden).toBe(false);
    expect(dirtyDot(btn).hidden).toBe(false);
    expect(tm.activeLinkedProfileId()).toBe("p1");
  });

  it("setActiveLinkedProfileId links the active tab and refreshes its badge", async () => {
    const tm = makeManager({ resolveTabState: (id) => ({ linked: id !== null, dirty: false }) });
    await tm.init();
    expect(badge(tabButtons()[0]!).hidden).toBe(true);

    tm.setActiveLinkedProfileId("p1");

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
    tm.setActiveLinkedProfileId("p9");

    const s = tm.serialize();
    expect(s.tabs).toHaveLength(2);
    expect(s.activeIndex).toBe(1);
    expect(s.tabs[1]?.linkedProfileId).toBe("p9");
    expect(s.tabs[1]?.panes).toEqual([{ deviceId: null }]); // from the fake snapshot
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

      tm.setActiveLinkedProfileId("p2"); // a real change → schedules a save
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
    tm.setActiveLinkedProfileId("p1"); // tab 0 → p1
    await tm.newTab();
    tm.setActiveLinkedProfileId("p1"); // tab 1 → p1 (now active)

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

      tm.setActiveLinkedProfileId("p1"); // schedules a debounced save
      tm.flushPersist();
      expect(persist).toHaveBeenCalledTimes(1); // fired without waiting the debounce

      tm.setActiveLinkedProfileId("p2");
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
