/**
 * The multi-pane grid (SPEC §7, Phase 3): an N×M CSS Grid of independent
 * `TerminalPane`s, a toolbar preset picker, draggable splitters, pane focus, and
 * the grid-shrink teardown flow. This module is thin DOM glue — every layout
 * decision (preset → model, splitter clamping/normalization, row-major pane
 * remapping, confirm copy) lives in the pure, unit-tested `gridModel.ts`.
 */

import { TerminalPane } from "./terminal/pane";
import {
  paneCount,
  presetIdFor,
  presetToModel,
  remapPanes,
  type GridModel,
  type PaneRemap,
  type PresetId,
} from "./gridModel";
import { shouldConfirmTeardown, type WorkspaceSnapshot } from "./profiles/workspace";
import { requireEl } from "./ui/dom";
import { t } from "./i18n";
import type { TerminalSettings } from "./ipc";
import { draggedModel, layoutGrid, type DragAxis, type SplitterDrag } from "./grid/gridSplitters";
import {
  markActivePreset,
  renderGridToolbar,
  setPresetButtonsDisabled,
  showBroadcastButton,
} from "./grid/gridToolbar";
import { confirmSessionTeardown } from "./ui/sessionTeardown";

export interface GridOptions {
  onError?: (message: string) => void;
  /**
   * Fired after any change to the saved-state of the workspace (grid shape,
   * splitter sizes, or a pane's assigned device). The profile manager uses it
   * to recompute the dirty-state dot (Phase 4). Suppressed during a profile
   * load, which emits exactly one change at the end.
   */
  onChange?: () => void;
  /** Supplies current terminal appearance settings to each pane (Phase 5). */
  getTerminalSettings?: () => TerminalSettings;
  /** A pane's status changed (or a pane went away): the side menu recounts
   * the connected devices. */
  onConnectionChange?: () => void;
}

/** One grid cell: the wrapper element (grid item) and its `TerminalPane`. */
interface Cell {
  wrapper: HTMLElement;
  pane: TerminalPane;
}

export class Grid {
  private root: HTMLElement;
  private options: GridOptions;
  private model: GridModel;
  private cells: Cell[] = [];
  private focusedIndex = 0;
  // Re-entrancy guard: at most one grid-shape transition may be in flight. A
  // transition has async windows (awaiting `createCell()` / the confirm dialog)
  // during which the toolbar would otherwise stay clickable — see `setPreset`.
  private transitioning = false;
  // While a profile load is applying, per-pane changes are suppressed so the
  // dirty dot doesn't flicker; `applySnapshot` emits a single change at the end.
  private loading = false;
  // What a load is building, until its panes exist: the grid's snapshot
  // meanwhile, so a Save right after Load saves what was loaded.
  private loadingSnapshot: WorkspaceSnapshot | null = null;
  // Set by `dispose()` (its tab closed). Cell creation awaits, so a build in
  // flight must stop there rather than add (and connect) panes nobody can close.
  private disposed = false;
  // Broadcast mode: when on, input typed into any connected pane is mirrored to
  // every *other* connected pane, so one command runs across all of them. A
  // pure view state (not part of the saved workspace), toggled from the toolbar.
  private broadcast = false;

  private toolbar: HTMLElement | null = null;
  private container: HTMLElement | null = null;

  // Splitter drag state. `drag` is non-null only while a splitter is held; the
  // pointer position is coalesced into a single rAF so we relayout/re-fit at most
  // once per frame instead of on every mousemove (SPEC §7).
  private drag: SplitterDrag | null = null;
  private dragPointer = { x: 0, y: 0 };
  private dragRaf = 0;

  constructor(root: HTMLElement, options: GridOptions = {}) {
    this.root = root;
    this.options = options;
    this.model = presetToModel("1x1");
  }

  async init(): Promise<void> {
    this.root.classList.add("grid-root");
    this.root.innerHTML = `
      <div class="grid-toolbar" role="toolbar" aria-label="${t("grid.toolbar.aria")}"></div>
      <div class="grid-container"></div>
    `;
    this.toolbar = requireEl<HTMLElement>(this.root, ".grid-toolbar");
    this.container = requireEl<HTMLElement>(this.root, ".grid-container");
    this.renderToolbar();

    const cells = await this.createLiveCells(paneCount(this.model));
    if (!cells) return;
    this.cells = cells;
    this.container.append(...this.cells.map((c) => c.wrapper));
    this.applyLayout();
    this.setFocus(0, false);
  }

  /** Reloads every pane's device dropdown (after a device add/edit/delete). */
  async refreshDevices(): Promise<void> {
    await Promise.all(this.cells.map((c) => c.pane.refreshDevices()));
  }

  /** Re-render the toolbar and every pane's chrome in the current locale
   * (language change). Live terminals and layout are untouched. */
  retranslate(): void {
    this.toolbar?.setAttribute("aria-label", t("grid.toolbar.aria"));
    this.renderToolbar();
    for (const cell of this.cells) cell.pane.retranslate();
  }

  /* -------------------------------------------------------------------------
   * Toolbar / presets
   * ---------------------------------------------------------------------- */

  private renderToolbar(): void {
    const toolbar = this.toolbar;
    if (!toolbar) return;
    renderGridToolbar(toolbar, {
      onPreset: (id) => void this.setPreset(id),
      onBroadcast: () => this.toggleBroadcast(),
    });
    this.updateBroadcastUI();
    this.updateToolbarActive();
  }

  private updateToolbarActive(): void {
    if (this.toolbar) markActivePreset(this.toolbar, presetIdFor(this.model));
  }

  /* -------------------------------------------------------------------------
   * Broadcast mode
   * ---------------------------------------------------------------------- */

  /** Flip broadcast mode on/off and refresh its toolbar + grid indicator. */
  private toggleBroadcast(): void {
    this.broadcast = !this.broadcast;
    this.updateBroadcastUI();
  }

  /** Reflect the current broadcast state in the toggle button and the grid
   * container's indicator class (a highlight on the panes while it is on). */
  private updateBroadcastUI(): void {
    if (this.toolbar) showBroadcastButton(this.toolbar, this.broadcast);
    this.container?.classList.toggle("grid-broadcasting", this.broadcast);
  }

  /** A load swaps every pane to (potentially) different hosts, so silently
   * keeping broadcast on would fan the next keystroke out to hosts the user
   * didn't choose to broadcast to. */
  private stopBroadcast(): void {
    if (!this.broadcast) return;
    this.broadcast = false;
    this.updateBroadcastUI();
  }

  /**
   * Fan one pane's locally-typed input out to the other connected panes when
   * broadcast mode is on. The source pane already wrote the input to its own
   * PTY (in its `onData` handler), so it is excluded here; disconnected panes
   * are skipped by `sendInput`'s own guard.
   */
  private onPaneInput(source: TerminalPane, data: string): void {
    if (!this.broadcast) return;
    // Skip the source (it already wrote its own input) and any pane that isn't
    // connected — `sendInput` self-guards too, but checking here keeps the
    // intent explicit and testable.
    const targets = this.cells.filter((cell) => cell.pane !== source && cell.pane.isConnected());
    for (const cell of targets) cell.pane.sendInput(data);
  }

  /** Where a library command goes: every connected pane while broadcasting,
   * else the focused pane when it is connected. */
  commandTargets(): TerminalPane[] {
    const cells = this.broadcast ? this.cells : this.cells.slice(this.focusedIndex, this.focusedIndex + 1);
    return cells.map((cell) => cell.pane).filter((pane) => pane.isConnected());
  }

  /**
   * Switches to a preset. On a shrink, panes beyond the new count are dropped in
   * row-major order; if any carries a live session the user must confirm first
   * (SPEC §7). Kept panes (and their live sessions) are preserved in place.
   */
  private async setPreset(id: PresetId): Promise<void> {
    const container = this.beginTransition();
    if (!container) return;
    try {
      const next = presetToModel(id);
      const remap = remapPanes(this.cells.length, paneCount(next));
      if (!(await this.confirmDropIfLive(remap.dropped))) return;

      await this.rebuildCellsForPreset(container, next, remap);
      this.emitChange();
    } finally {
      this.endTransition();
    }
  }

  /**
   * Marks a layout transition as in flight and returns the container to operate
   * on, or `null` if one can't start right now — either there's no container
   * yet, or a transition is already running. Claiming exclusivity here, before
   * any `await`, is what stops overlapping `setPreset`/`applySnapshot` calls from
   * interleaving mutations of `this.cells`/`this.model`: without it, whichever
   * call finished last would overwrite `this.cells` and orphan cells the other
   * appended to the DOM — their ResizeObserver / `session_status` listener /
   * xterm Terminal / live SSH session then unreachable by `dispose()`.
   */
  private beginTransition(): HTMLElement | null {
    if (!this.container || this.transitioning) return null;
    this.transitioning = true;
    this.setPresetButtonsDisabled(true);
    return this.container;
  }

  /** Releases the transition claim taken by {@link beginTransition}. */
  private endTransition(): void {
    this.transitioning = false;
    this.setPresetButtonsDisabled(false);
  }

  /** Confirms tearing down any live sessions among the cells a shrink would drop. */
  private async confirmDropIfLive(dropped: number[]): Promise<boolean> {
    const liveCount = dropped.filter(
      (i) => this.cells[i]?.pane.hasLiveSession() ?? false,
    ).length;
    if (liveCount === 0) return true;
    return confirmSessionTeardown(liveCount);
  }

  /**
   * Tears down the panes a preset switch drops, creates the panes it adds, and
   * re-renders the layout/focus around the resulting cell list.
   */
  private async rebuildCellsForPreset(
    container: HTMLElement,
    next: GridModel,
    remap: PaneRemap,
  ): Promise<void> {
    this.disposeCells(remap.dropped);
    const kept = this.cells.slice(0, paneCount(next));
    const added = await this.createLiveCells(remap.added.length);
    if (!added) return;
    this.cells = [...kept, ...added];
    this.model = next;

    // Re-order DOM to match the new row-major cell list (appendChild moves the
    // kept nodes; new nodes are inserted at the end).
    for (const cell of this.cells) container.appendChild(cell.wrapper);

    this.applyLayout();
    this.updateToolbarActive();
    this.setFocus(Math.min(this.focusedIndex, this.cells.length - 1), false);
  }

  /** Tears down the cells at `indices` (disposes listeners/observers and
   * closes any backend session — see TerminalPane.dispose). */
  private disposeCells(indices: number[]): void {
    for (const i of indices) {
      const cell = this.cells[i];
      if (cell) destroyCell(cell);
    }
  }

  /** Notifies the profile manager that the workspace saved-state may have changed. */
  private emitChange(): void {
    if (!this.loading) this.options.onChange?.();
  }

  /* -------------------------------------------------------------------------
   * Profiles (SPEC §4/§7, Phase 4)
   * ---------------------------------------------------------------------- */

  /** A comparable snapshot of the live workspace (grid + row-major device ids). */
  snapshot(): WorkspaceSnapshot {
    if (this.loadingSnapshot) return copySnapshot(this.loadingSnapshot);
    return {
      grid: {
        rows: this.model.rows,
        cols: this.model.cols,
        rowSizes: [...this.model.rowSizes],
        colSizes: [...this.model.colSizes],
      },
      panes: this.cells.map((c) => c.pane.getDeviceId()),
    };
  }

  /** False while a load is still building its panes: {@link snapshot} would
   * then give the new layout with its devices missing. */
  isSnapshotComplete(): boolean {
    return this.cells.length === paneCount(this.model);
  }

  /** The devices of the panes whose status reads "connected". */
  connectedDeviceIds(): string[] {
    return this.cells
      .filter((cell) => cell.pane.showsConnected())
      .map((cell) => cell.pane.getDeviceId())
      .filter((id): id is string => id !== null);
  }

  /** Number of panes currently holding a live session. */
  liveSessionCount(): number {
    return this.cells.filter((c) => c.pane.hasLiveSession()).length;
  }

  /** Apply terminal appearance settings live to every pane's terminal (Phase 5). */
  applyTerminalSettings(settings: TerminalSettings): void {
    for (const cell of this.cells) cell.pane.applyTerminalSettings(settings);
  }

  /**
   * Re-fit every pane to its container and push the resulting size to any live
   * PTY (Tabs, Phase 1). A hidden grid (`display:none`) can't be measured by
   * xterm's FitAddon, so its terminals are laid out at zero size while
   * backgrounded; `TabManager` calls this right after unhiding the tab so the
   * now-visible terminals size correctly. Mirrors the fit→syncSize sequence the
   * splitter drag runs on drag-end.
   */
  refit(): void {
    this.fitPanes();
    for (const cell of this.cells) cell.pane.syncSize();
  }

  /** Focus this grid's currently-focused pane (used when its tab is shown). */
  focus(): void {
    this.setFocus(this.focusedIndex, true);
  }

  /**
   * Rebuild the grid from a workspace snapshot (grid shape + row-major device
   * ids): one tab of a profile being loaded (SPEC §7), or a tab's saved
   * workspace restored on launch (Tabs, Phase 3). See {@link applyWorkspace}.
   */
  async applySnapshot(
    snapshot: WorkspaceSnapshot,
    opts: { confirmTeardown?: boolean } = {},
  ): Promise<boolean> {
    return this.applyWorkspace(snapshot, opts);
  }

  /**
   * Body of {@link applySnapshot}: if any session
   * is live, confirm the teardown first (unless `confirmTeardown` is false, e.g.
   * an app-start restore); then rebuild the grid to the snapshot's shape and
   * auto-connect every assigned pane in parallel. Per-pane connect failures
   * surface in that pane's own error overlay and never block the others. Returns
   * `false` if the user cancelled.
   */
  private async applyWorkspace(
    snapshot: WorkspaceSnapshot,
    opts: { confirmTeardown?: boolean },
  ): Promise<boolean> {
    const container = this.beginTransition();
    if (!container) return false;
    try {
      if (!(await this.confirmProfileTeardown(opts.confirmTeardown))) {
        return false;
      }
      await this.loadWorkspaceCells(container, snapshot);
    } finally {
      this.endTransition();
    }
    this.emitChange();
    return true;
  }

  /** Confirms tearing down any live sessions before loading over them, unless
   * `confirmTeardown` is false. */
  private async confirmProfileTeardown(confirmTeardown: boolean | undefined): Promise<boolean> {
    if (confirmTeardown === false || !shouldConfirmTeardown(this.liveSessionCount())) {
      return true;
    }
    return confirmSessionTeardown(this.liveSessionCount());
  }

  /**
   * Tears the current grid down completely, rebuilds it to the snapshot's shape,
   * then assigns and auto-connects its panes.
   */
  private async loadWorkspaceCells(
    container: HTMLElement,
    snapshot: WorkspaceSnapshot,
  ): Promise<void> {
    this.loading = true;
    this.loadingSnapshot = copySnapshot(snapshot);
    try {
      await this.rebuildFromSnapshot(container, snapshot);
    } finally {
      this.loading = false;
      this.loadingSnapshot = null;
    }
  }

  private async rebuildFromSnapshot(container: HTMLElement, snapshot: WorkspaceSnapshot): Promise<void> {
    this.teardownAllCells();
    this.stopBroadcast();
    this.model = modelOf(snapshot);
    const cells = await this.createLiveCells(paneCount(this.model));
    if (!cells) return;
    this.mountLoadedCells(container, cells);
    const connects = this.assignSnapshotDevices(snapshot);
    // The layout and devices already match the snapshot: report it now rather
    // than after every connect settles (host-key prompts, timeouts), so a
    // just-loaded profile tab doesn't read as unsaved meanwhile.
    this.options.onChange?.();
    await Promise.allSettled(connects);
  }

  private mountLoadedCells(container: HTMLElement, cells: Cell[]): void {
    this.cells = cells;
    this.loadingSnapshot = null;
    container.append(...this.cells.map((c) => c.wrapper));
    this.applyLayout();
    this.updateToolbarActive();
    this.focusedIndex = 0;
    this.setFocus(0, false);
  }

  /** Disposes every current pane (closing any live session) and clears the grid. */
  private teardownAllCells(): void {
    this.cells.forEach(destroyCell);
    this.cells = [];
  }

  /** Assigns each cell's device from the snapshot and starts connecting the
   * assigned ones in parallel; returns those connects. */
  private assignSnapshotDevices(snapshot: WorkspaceSnapshot): Promise<void>[] {
    const connects: Promise<void>[] = [];
    this.cells.forEach((cell, i) => {
      const deviceId = snapshot.panes[i] ?? null;
      cell.pane.assignDevice(deviceId);
      if (deviceId) connects.push(cell.pane.connectAssigned());
    });
    return connects;
  }

  /** Enables/disables the preset buttons for the duration of a transition. */
  private setPresetButtonsDisabled(disabled: boolean): void {
    if (this.toolbar) setPresetButtonsDisabled(this.toolbar, disabled);
  }

  /* -------------------------------------------------------------------------
   * Cells
   * ---------------------------------------------------------------------- */

  /** Creates `count` cells, or `null` when the grid is disposed meanwhile:
   * those cells were never in `cells`, so `dispose()` missed them and they are
   * disposed here instead. */
  private async createLiveCells(count: number): Promise<Cell[] | null> {
    const cells: Cell[] = [];
    for (let i = 0; i < count; i++) {
      cells.push(await this.createCell());
      if (this.disposed) return disposeAbandoned(cells);
    }
    return cells;
  }

  private async createCell(): Promise<Cell> {
    const wrapper = document.createElement("div");
    wrapper.className = "grid-cell";
    const pane = new TerminalPane(wrapper, {
      onError: this.options.onError,
      onChange: () => this.emitChange(),
      onStatusChange: () => this.options.onConnectionChange?.(),
      getTerminalSettings: this.options.getTerminalSettings,
      // Referencing `pane` here is safe: the callback only ever runs after this
      // `const` has been initialised (once a live terminal emits input).
      onInput: (data) => this.onPaneInput(pane, data),
    });
    // Clicking a cell focuses it (ring + keyboard focus into the terminal),
    // unless the click landed on a header control (device select / buttons),
    // in which case the native control keeps focus.
    wrapper.addEventListener("mousedown", (e) => {
      const index = this.indexOfWrapper(wrapper);
      if (index < 0) return;
      const onHeaderControl =
        e.target instanceof HTMLElement && e.target.closest(".pane-header");
      this.setFocus(index, !onHeaderControl);
    });
    await pane.init();
    return { wrapper, pane };
  }

  private indexOfWrapper(wrapper: HTMLElement): number {
    return this.cells.findIndex((c) => c.wrapper === wrapper);
  }

  private setFocus(index: number, focusTerminal: boolean): void {
    if (!this.hasCell(index)) return;
    this.focusedIndex = index;
    this.cells.forEach((cell, i) => {
      cell.wrapper.classList.toggle("grid-cell-focused", i === index);
    });
    if (focusTerminal) this.focusPane(index);
  }

  private hasCell(index: number): boolean {
    return index >= 0 && index < this.cells.length;
  }

  private focusPane(index: number): void {
    this.cells[index]?.pane.focus();
  }

  /* -------------------------------------------------------------------------
   * Layout (CSS grid tracks + splitters)
   * ---------------------------------------------------------------------- */

  /** Lays the grid out to the current model (see `layoutGrid`). */
  private applyLayout(): void {
    if (!this.container) return;
    layoutGrid(this.container, this.model, (e, axis, boundary) => this.startDrag(e, axis, boundary));
  }

  /* -------------------------------------------------------------------------
   * Splitter drag
   * ---------------------------------------------------------------------- */

  private startDrag(e: MouseEvent, axis: DragAxis, boundary: number): void {
    e.preventDefault();
    this.drag = { axis, boundary };
    this.dragPointer = { x: e.clientX, y: e.clientY };
    document.body.classList.add(
      axis === "col" ? "grid-dragging-col" : "grid-dragging-row",
    );
    // Defer PTY resizes to drag end: panes still re-fit visually every frame.
    for (const cell of this.cells) cell.pane.setResizeThrottled(true);
    window.addEventListener("mousemove", this.onDragMove);
    window.addEventListener("mouseup", this.onDragEnd);
  }

  private onDragMove = (e: MouseEvent): void => {
    if (!this.drag) return;
    this.dragPointer = { x: e.clientX, y: e.clientY };
    if (this.dragRaf === 0) {
      this.dragRaf = requestAnimationFrame(this.applyDrag);
    }
  };

  private applyDrag = (): void => {
    this.dragRaf = 0;
    const { drag, container } = this;
    if (!drag || !container) return;
    this.model = draggedModel(this.model, drag, this.dragPointer, container.getBoundingClientRect());
    this.applyLayout();
    // Re-fit visually (once per frame); resize_pty is held until drag end.
    this.fitPanes();
  };

  private fitPanes(): void {
    for (const cell of this.cells) cell.pane.fit();
  }

  private onDragEnd = (): void => {
    window.removeEventListener("mousemove", this.onDragMove);
    window.removeEventListener("mouseup", this.onDragEnd);
    this.cancelDragFrame();
    this.endDragChrome();
    for (const cell of this.cells) cell.pane.setResizeThrottled(false);
    // Push the final size to every live session's PTY exactly once.
    for (const cell of this.cells) cell.pane.syncSize();
    // Splitter sizes are part of the saved-state → may now differ from profile.
    this.emitChange();
  };

  /** Ends a drag's app-wide state: the body's dragging cursor class. */
  private endDragChrome(): void {
    document.body.classList.remove("grid-dragging-col", "grid-dragging-row");
    this.drag = null;
  }

  private cancelDragFrame(): void {
    if (this.dragRaf === 0) return;
    cancelAnimationFrame(this.dragRaf);
    this.dragRaf = 0;
  }

  /**
   * Full teardown when its tab closes: disposes every pane (which closes any
   * live backend session) and removes the grid-level drag listeners. A pane
   * build still in flight stops at its next await (see `createLiveCells`).
   *
   * NOTE: app-close clean disconnect (SPEC §7) is handled on the *backend* — a
   * Tauri `CloseRequested` handler calls `SessionManager::disconnect_all()`
   * before the window is destroyed (see `src-tauri/src/lib.rs`), which is robust
   * even if the webview is already tearing down.
   */
  dispose(): void {
    this.disposed = true;
    window.removeEventListener("mousemove", this.onDragMove);
    window.removeEventListener("mouseup", this.onDragEnd);
    this.cancelDragFrame();
    // Only a grid mid-drag owns the body's dragging class.
    if (this.drag) this.endDragChrome();
    this.teardownAllCells();
  }
}

/** A copy sharing no arrays with `snapshot`. */
function copySnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  const { grid, panes } = snapshot;
  return {
    grid: { ...grid, rowSizes: [...grid.rowSizes], colSizes: [...grid.colSizes] },
    panes: [...panes],
  };
}

function modelOf(snapshot: WorkspaceSnapshot): GridModel {
  const { grid } = snapshot;
  return { rows: grid.rows, cols: grid.cols, rowSizes: [...grid.rowSizes], colSizes: [...grid.colSizes] };
}

function destroyCell(cell: Cell): void {
  cell.pane.dispose();
  cell.wrapper.remove();
}

/** Disposes cells a disposed grid never adopted; always `null`. */
function disposeAbandoned(cells: Cell[]): null {
  for (const cell of cells) cell.pane.dispose();
  return null;
}
