/**
 * @vitest-environment happy-dom
 *
 * DOM-lifecycle regression tests for the multi-pane `Grid` (Phase 3). These
 * cover the phase's stated focus — "listener/observer cleanup when panes are
 * destroyed" — which previously had no automated coverage:
 *
 *   1. A grid shrink disposes every dropped pane and leaves no orphaned
 *      `.grid-cell` DOM nodes.
 *   2. `Grid.dispose()` disposes every pane and clears the grid.
 *   3. Overlapping `setPreset` calls (a rapid double-click) must NOT orphan
 *      cells — the re-entrancy guard keeps `this.cells` and the DOM in agreement.
 *      This test FAILS if the guard in `setPreset` is removed.
 *
 * Uses the same happy-dom + `vi.mock("./ipc", ...)` pattern as `pane.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionStatusEvent } from "./ipc";

const connectMock = vi.fn(
  async (_deviceId: string, _cols?: number, _rows?: number, _ch?: unknown): Promise<string> =>
    "sess-1",
);

vi.mock("./ipc", () => ({
  listDevices: vi.fn(async () => [
    { id: "dev-1", name: "A", host: "h", port: 22, username: "u", auth: { method: "password" } },
    { id: "dev-2", name: "B", host: "h", port: 22, username: "u", auth: { method: "password" } },
  ]),
  // Forwarding closure (not `connectMock` directly): the mock factory is
  // hoisted above the `const`, so referencing it here would hit the TDZ; the
  // closure defers access until the mock is actually called.
  connect: (deviceId: string, cols: number, rows: number, ch: unknown) =>
    connectMock(deviceId, cols, rows, ch),
  disconnect: vi.fn(async () => {}),
  writeStdin: vi.fn(async () => {}),
  resizePty: vi.fn(async () => {}),
  newDataChannel: vi.fn(() => ({ onmessage: null })),
  onSessionStatus: vi.fn(
    async (_handler: (e: SessionStatusEvent) => void) => () => {},
  ),
}));

// Imported after the mock is registered so the module graph uses it.
import { Grid } from "./grid";
import type { Profile } from "./ipc";
import type { TerminalPane } from "./terminal/pane";

/** Narrow, test-only view of `Grid`'s private surface (mirrors pane.test.ts). */
interface GridInternals {
  cells: Array<{ wrapper: HTMLElement; pane: TerminalPane }>;
  model: { rows: number; cols: number };
  setPreset(id: string): Promise<void>;
}

function internals(grid: Grid): GridInternals {
  return grid as unknown as GridInternals;
}

function domCellCount(): number {
  return document.querySelectorAll(".grid-cell").length;
}

/** Let queued microtasks (the awaited createCell chains) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function makeGrid(): Grid {
  const root = document.querySelector<HTMLElement>("#pane-root");
  if (!root) throw new Error("test: #pane-root not found");
  return new Grid(root);
}

describe("Grid pane teardown", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="pane-root"></div>';
  });

  it("disposes every dropped pane and leaves no orphaned cells on a shrink", async () => {
    const grid = makeGrid();
    await grid.init();

    await internals(grid).setPreset("2x2");
    expect(internals(grid).cells.length).toBe(4);
    expect(domCellCount()).toBe(4);

    // Spy on the three panes that a 2x2 → 1x1 shrink must drop.
    const dropped = internals(grid).cells.slice(1);
    const spies = dropped.map((c) => vi.spyOn(c.pane, "dispose"));

    await internals(grid).setPreset("1x1");

    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
    expect(internals(grid).cells.length).toBe(1);
    expect(domCellCount()).toBe(1);
  });

  it("Grid.dispose() disposes all panes and clears the grid", async () => {
    const grid = makeGrid();
    await grid.init();
    await internals(grid).setPreset("2x2");

    const spies = internals(grid).cells.map((c) =>
      vi.spyOn(c.pane, "dispose"),
    );
    grid.dispose();

    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
    expect(internals(grid).cells.length).toBe(0);
    expect(domCellCount()).toBe(0);
  });

  it("ignores a re-entrant setPreset so no cells are orphaned (guard)", async () => {
    const grid = makeGrid();
    await grid.init();

    // Two overlapping transitions (a rapid double / double-preset click): fire
    // the second WITHOUT awaiting the first. The guard must make the second a
    // no-op; without it, the later-finishing call overwrites `this.cells` and
    // orphans DOM cells the other appended. The model count and DOM count must
    // stay in agreement.
    const p1 = internals(grid).setPreset("2x2");
    const p2 = internals(grid).setPreset("3x2");
    await Promise.all([p1, p2]);
    await flush();

    expect(internals(grid).cells.length).toBe(domCellCount());
  });
});

describe("Grid splitter drag DOM churn (F4)", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="pane-root"></div>';
  });

  /** Narrow view into the private drag state / callback exercised by a drag tick. */
  interface DragInternals {
    drag: { axis: "col" | "row"; boundary: number } | null;
    dragPointer: { x: number; y: number };
    applyDrag: () => void;
  }

  function dragInternals(grid: Grid): DragInternals {
    return grid as unknown as DragInternals;
  }

  // Guards F4: `applyDrag` (the rAF drag callback) used to call `applyLayout()`,
  // which removed and recreated every `.grid-splitter` node — including the one
  // being dragged — on every frame. FAILS (splitter identities change) if a
  // drag tick with an unchanged track count goes back to a full rebuild instead
  // of repositioning the existing nodes in place.
  it("repositions existing splitters during a drag tick instead of recreating them", async () => {
    const grid = makeGrid();
    await grid.init();
    await internals(grid).setPreset("2x2"); // 1 col splitter + 1 row splitter

    const before = Array.from(
      document.querySelectorAll<HTMLElement>(".grid-splitter"),
    );
    expect(before.length).toBe(2);

    const drag = dragInternals(grid);
    drag.drag = { axis: "col", boundary: 0 };
    drag.dragPointer = { x: 100, y: 100 };
    drag.applyDrag();

    const after = Array.from(
      document.querySelectorAll<HTMLElement>(".grid-splitter"),
    );
    expect(after.length).toBe(2);
    // Same DOM node identities — not torn down and recreated.
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });

  // A shape change (different splitter count per axis) must still fully rebuild.
  it("still rebuilds splitters when the track count changes (preset switch)", async () => {
    const grid = makeGrid();
    await grid.init(); // 1x1 → 0 splitters
    expect(document.querySelectorAll(".grid-splitter").length).toBe(0);

    await internals(grid).setPreset("2x2");
    expect(document.querySelectorAll(".grid-splitter-col").length).toBe(1);
    expect(document.querySelectorAll(".grid-splitter-row").length).toBe(1);
  });
});

describe("Grid profiles (Phase 4)", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="pane-root"></div>';
    connectMock.mockReset();
    connectMock.mockResolvedValue("sess-1");
  });

  function profile(): Profile {
    return {
      id: "p1",
      name: "Homelab",
      grid: { rows: 1, cols: 2, rowSizes: [1], colSizes: [0.5, 0.5] },
      panes: [{ deviceId: "dev-1" }, { deviceId: null }],
    };
  }

  function twoDeviceProfile(id: string): Profile {
    return {
      id,
      name: id,
      grid: { rows: 1, cols: 2, rowSizes: [1], colSizes: [0.5, 0.5] },
      panes: [{ deviceId: "dev-1" }, { deviceId: "dev-2" }],
    };
  }

  function clickConfirm(): void {
    const btn = document.querySelector<HTMLButtonElement>(
      '.confirm-dialog [data-action="confirm"]',
    );
    btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }

  it("applyProfile rebuilds the grid to the profile shape and auto-connects assigned panes", async () => {
    const grid = makeGrid();
    await grid.init(); // 1x1

    const applied = await grid.applyProfile(profile(), { confirmTeardown: false });
    await flush();

    expect(applied).toBe(true);
    expect(internals(grid).cells.length).toBe(2);
    expect(domCellCount()).toBe(2);
    // Only the assigned (non-null) pane auto-connects.
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it("snapshot round-trips the applied profile (grid shape + pane device ids)", async () => {
    const grid = makeGrid();
    await grid.init();
    await grid.applyProfile(profile(), { confirmTeardown: false });
    await flush();

    const snap = grid.snapshot();
    expect(snap.grid).toEqual(profile().grid);
    expect(snap.panes).toEqual(["dev-1", null]);
  });

  it("does not orphan cells when loading over an existing grid", async () => {
    const grid = makeGrid();
    await grid.init();
    await internals(grid).setPreset("3x2"); // 6 cells
    expect(domCellCount()).toBe(6);

    await grid.applyProfile(profile(), { confirmTeardown: false }); // 2 cells
    await flush();

    expect(internals(grid).cells.length).toBe(2);
    expect(domCellCount()).toBe(2);
  });

  it("auto-connects multiple assigned panes in parallel, isolating a failure", async () => {
    // dev-1's connect fails; dev-2's succeeds. The failing pane must not have a
    // live session while its sibling does, and neither cell may go missing.
    connectMock.mockImplementation(async (deviceId: string) => {
      if (deviceId === "dev-1") throw { code: "SshConnect", message: "nope" };
      return "sess-2";
    });
    const grid = makeGrid();
    await grid.init();

    await grid.applyProfile(twoDeviceProfile("p"), { confirmTeardown: false });
    await flush();

    expect(connectMock).toHaveBeenCalledTimes(2); // both attempted in parallel
    expect(internals(grid).cells.length).toBe(2);
    expect(domCellCount()).toBe(2);
    expect(internals(grid).cells[0]?.pane.hasLiveSession()).toBe(false); // dev-1 failed
    expect(internals(grid).cells[1]?.pane.hasLiveSession()).toBe(true); // dev-2 live
  });

  it("is exclusive with a second load fired while its confirm dialog is open (guard)", async () => {
    const grid = makeGrid();
    await grid.init();
    // Establish one live session so the next load triggers a teardown confirm.
    await grid.applyProfile(profile(), { confirmTeardown: false });
    await flush();
    expect(grid.liveSessionCount()).toBe(1);

    // First load (default confirmTeardown:true) suspends at the confirm dialog.
    const pB = grid.applyProfile(twoDeviceProfile("B"));
    // Second load fired WHILE the dialog is open must be a no-op — not a second
    // dialog. Before the guard fix this produced two stacked dialogs and a
    // corrupted grid (cells.length != model panes).
    const pC = grid.applyProfile(twoDeviceProfile("C"));
    expect(document.querySelectorAll(".confirm-dialog").length).toBe(1);
    expect(await pC).toBe(false);

    clickConfirm();
    expect(await pB).toBe(true);
    await flush();

    const inner = internals(grid);
    expect(inner.cells.length).toBe(domCellCount());
    expect(inner.cells.length).toBe(inner.model.rows * inner.model.cols);
  });
});
