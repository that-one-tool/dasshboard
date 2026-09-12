/**
 * The multi-pane grid (SPEC §7, Phase 3): an N×M CSS Grid of independent
 * `TerminalPane`s, a toolbar preset picker, draggable splitters, pane focus, and
 * the grid-shrink teardown flow. This module is thin DOM glue — every layout
 * decision (preset → model, splitter clamping/normalization, row-major pane
 * remapping, confirm copy) lives in the pure, unit-tested `gridModel.ts`.
 */

import { TerminalPane } from "./terminal/pane";
import {
  cumulativeFractions,
  paneCount,
  presetIdFor,
  presetToModel,
  remapPanes,
  resizeTrack,
  shrinkConfirmMessage,
  PRESET_IDS,
  type GridModel,
  type PaneRemap,
  type PresetId,
} from "./gridModel";
import { shouldConfirmTeardown, type WorkspaceSnapshot } from "./profiles/workspace";
import { confirm } from "./ui/confirm";
import { requireEl } from "./ui/dom";
import type { Profile, TerminalSettings } from "./ipc";

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
}

/** One grid cell: the wrapper element (grid item) and its `TerminalPane`. */
interface Cell {
  wrapper: HTMLElement;
  pane: TerminalPane;
}

type DragAxis = "col" | "row";

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
  // dirty dot doesn't flicker; `applyProfile` emits a single change at the end.
  private loading = false;

  private toolbar: HTMLElement | null = null;
  private container: HTMLElement | null = null;

  // Splitter drag state. `drag` is non-null only while a splitter is held; the
  // pointer position is coalesced into a single rAF so we relayout/re-fit at most
  // once per frame instead of on every mousemove (SPEC §7).
  private drag: { axis: DragAxis; boundary: number } | null = null;
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
      <div class="grid-toolbar" role="toolbar" aria-label="Grid layout"></div>
      <div class="grid-container"></div>
    `;
    this.toolbar = requireEl<HTMLElement>(this.root, ".grid-toolbar");
    this.container = requireEl<HTMLElement>(this.root, ".grid-container");
    this.renderToolbar();

    for (let i = 0; i < paneCount(this.model); i++) {
      const cell = await this.createCell();
      this.cells.push(cell);
    }
    this.container.append(...this.cells.map((c) => c.wrapper));
    this.applyLayout();
    this.setFocus(0, false);
  }

  /** Reloads every pane's device dropdown (after a device add/edit/delete). */
  async refreshDevices(): Promise<void> {
    await Promise.all(this.cells.map((c) => c.pane.refreshDevices()));
  }

  /* -------------------------------------------------------------------------
   * Toolbar / presets
   * ---------------------------------------------------------------------- */

  private renderToolbar(): void {
    const toolbar = this.toolbar;
    if (!toolbar) return;
    toolbar.innerHTML = "";
    const label = document.createElement("span");
    label.className = "grid-toolbar-label";
    label.textContent = "Layout:";
    toolbar.appendChild(label);
    for (const id of PRESET_IDS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-small grid-preset-btn";
      btn.textContent = id;
      btn.dataset.preset = id;
      btn.addEventListener("click", () => void this.setPreset(id));
      toolbar.appendChild(btn);
    }
    this.updateToolbarActive();
  }

  private updateToolbarActive(): void {
    const toolbar = this.toolbar;
    if (!toolbar) return;
    const active = presetIdFor(this.model);
    for (const btn of toolbar.querySelectorAll<HTMLButtonElement>(
      ".grid-preset-btn",
    )) {
      btn.classList.toggle("grid-preset-active", btn.dataset.preset === active);
    }
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
   * any `await`, is what stops overlapping `setPreset`/`applyProfile` calls from
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
    return confirm(shrinkConfirmMessage(liveCount), {
      title: "Close sessions?",
      confirmLabel: "Continue",
      danger: true,
    });
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
    // Tear down dropped panes (disposes listeners/observers and closes any
    // backend session — see TerminalPane.dispose).
    for (const i of remap.dropped) {
      const cell = this.cells[i];
      if (!cell) continue;
      cell.pane.dispose();
      cell.wrapper.remove();
    }

    const kept = this.cells.slice(0, paneCount(next));
    const added: Cell[] = [];
    for (let i = 0; i < remap.added.length; i++) {
      added.push(await this.createCell());
    }
    this.cells = [...kept, ...added];
    this.model = next;

    // Re-order DOM to match the new row-major cell list (appendChild moves the
    // kept nodes; new nodes are inserted at the end).
    for (const cell of this.cells) container.appendChild(cell.wrapper);

    this.applyLayout();
    this.updateToolbarActive();
    this.setFocus(Math.min(this.focusedIndex, this.cells.length - 1), false);
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

  /** Number of panes currently holding a live session. */
  liveSessionCount(): number {
    return this.cells.filter((c) => c.pane.hasLiveSession()).length;
  }

  /** Apply terminal appearance settings live to every pane's terminal (Phase 5). */
  applyTerminalSettings(settings: TerminalSettings): void {
    for (const cell of this.cells) cell.pane.applyTerminalSettings(settings);
  }

  /**
   * Load a profile (SPEC §7): if any session is live, confirm the teardown
   * first (unless `confirmTeardown` is false, e.g. the app-start default load);
   * then rebuild the grid to the profile's shape and auto-connect every assigned
   * pane in parallel. Per-pane connect failures surface in that pane's own error
   * overlay and never block the others. Returns `false` if the user cancelled.
   */
  async applyProfile(
    profile: Profile,
    opts: { confirmTeardown?: boolean } = {},
  ): Promise<boolean> {
    const container = this.beginTransition();
    if (!container) return false;
    try {
      if (!(await this.confirmProfileTeardown(opts.confirmTeardown ?? true))) {
        return false;
      }
      await this.loadProfileCells(container, profile);
    } finally {
      this.endTransition();
    }
    this.emitChange();
    return true;
  }

  /** Confirms tearing down any live sessions before loading a profile over them. */
  private async confirmProfileTeardown(confirmTeardown: boolean): Promise<boolean> {
    if (!confirmTeardown || !shouldConfirmTeardown(this.liveSessionCount())) {
      return true;
    }
    return confirm(shrinkConfirmMessage(this.liveSessionCount()), {
      title: "Close sessions?",
      confirmLabel: "Continue",
      danger: true,
    });
  }

  /**
   * Tears the current grid down completely, rebuilds it to the profile's shape,
   * then assigns and auto-connects the profile's panes.
   */
  private async loadProfileCells(container: HTMLElement, profile: Profile): Promise<void> {
    this.loading = true;
    try {
      this.teardownAllCells();
      this.model = {
        rows: profile.grid.rows,
        cols: profile.grid.cols,
        rowSizes: [...profile.grid.rowSizes],
        colSizes: [...profile.grid.colSizes],
      };

      const count = paneCount(this.model);
      for (let i = 0; i < count; i++) {
        this.cells.push(await this.createCell());
      }
      container.append(...this.cells.map((c) => c.wrapper));
      this.applyLayout();
      this.updateToolbarActive();
      this.focusedIndex = 0;
      this.setFocus(0, false);

      await this.connectProfilePanes(profile);
    } finally {
      this.loading = false;
    }
  }

  /** Disposes every current pane (closing any live session) and clears the grid. */
  private teardownAllCells(): void {
    for (const cell of this.cells) {
      cell.pane.dispose();
      cell.wrapper.remove();
    }
    this.cells = [];
  }

  /** Assigns each cell's device from the profile, then connects the assigned ones in parallel. */
  private async connectProfilePanes(profile: Profile): Promise<void> {
    const connects: Promise<void>[] = [];
    this.cells.forEach((cell, i) => {
      const deviceId = profile.panes[i]?.deviceId ?? null;
      cell.pane.assignDevice(deviceId);
      if (deviceId) connects.push(cell.pane.connectAssigned());
    });
    await Promise.allSettled(connects);
  }

  /** Enables/disables the preset buttons for the duration of a transition. */
  private setPresetButtonsDisabled(disabled: boolean): void {
    const toolbar = this.toolbar;
    if (!toolbar) return;
    for (const btn of toolbar.querySelectorAll<HTMLButtonElement>(
      ".grid-preset-btn",
    )) {
      btn.disabled = disabled;
    }
  }

  /* -------------------------------------------------------------------------
   * Cells
   * ---------------------------------------------------------------------- */

  private async createCell(): Promise<Cell> {
    const wrapper = document.createElement("div");
    wrapper.className = "grid-cell";
    const pane = new TerminalPane(wrapper, {
      onError: this.options.onError,
      onChange: () => this.emitChange(),
      getTerminalSettings: this.options.getTerminalSettings,
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
    if (index < 0 || index >= this.cells.length) return;
    this.focusedIndex = index;
    this.cells.forEach((cell, i) => {
      cell.wrapper.classList.toggle("grid-cell-focused", i === index);
    });
    if (focusTerminal) this.cells[index]?.pane.focus();
  }

  /* -------------------------------------------------------------------------
   * Layout (CSS grid tracks + splitters)
   * ---------------------------------------------------------------------- */

  /**
   * Applies the current model's track sizes to the grid, then updates the
   * splitter overlay. A splitter drag calls this every animation frame with the
   * track *count* unchanged (only sizes move) — rebuilding every splitter node
   * on each tick would churn the DOM up to 60x/sec and drop `:hover`/`:active`
   * state on the dragged splitter. So the splitter count per axis is checked
   * first: unchanged ⇒ reposition the existing nodes in place (cheap, keeps
   * their listeners); changed (a preset/profile switch) ⇒ full rebuild.
   */
  private applyLayout(): void {
    const container = this.container;
    if (!container) return;
    container.style.gridTemplateColumns = this.model.colSizes
      .map((f) => `${f}fr`)
      .join(" ");
    container.style.gridTemplateRows = this.model.rowSizes
      .map((f) => `${f}fr`)
      .join(" ");

    if (this.splitterShapeMatches(container)) {
      this.repositionSplitters(container);
    } else {
      this.rebuildSplitters(container);
    }
  }

  /** True when the DOM already has exactly the col/row splitter count the model needs. */
  private splitterShapeMatches(container: HTMLElement): boolean {
    const expectedCols = Math.max(0, this.model.colSizes.length - 1);
    const expectedRows = Math.max(0, this.model.rowSizes.length - 1);
    const actualCols = container.querySelectorAll(".grid-splitter-col").length;
    const actualRows = container.querySelectorAll(".grid-splitter-row").length;
    return actualCols === expectedCols && actualRows === expectedRows;
  }

  /** Moves existing splitter nodes to the current boundary fractions, in place. */
  private repositionSplitters(container: HTMLElement): void {
    const cols = container.querySelectorAll<HTMLElement>(".grid-splitter-col");
    cumulativeFractions(this.model.colSizes).forEach((frac, i) => {
      const el = cols[i];
      if (el) el.style.left = `${frac * 100}%`;
    });
    const rows = container.querySelectorAll<HTMLElement>(".grid-splitter-row");
    cumulativeFractions(this.model.rowSizes).forEach((frac, i) => {
      const el = rows[i];
      if (el) el.style.top = `${frac * 100}%`;
    });
  }

  /** Removes and recreates every splitter (cells are left untouched). */
  private rebuildSplitters(container: HTMLElement): void {
    for (const s of container.querySelectorAll(".grid-splitter")) s.remove();
    cumulativeFractions(this.model.colSizes).forEach((frac, boundary) => {
      container.appendChild(this.makeSplitter("col", boundary, frac));
    });
    cumulativeFractions(this.model.rowSizes).forEach((frac, boundary) => {
      container.appendChild(this.makeSplitter("row", boundary, frac));
    });
  }

  private makeSplitter(
    axis: DragAxis,
    boundary: number,
    cumFraction: number,
  ): HTMLElement {
    const el = document.createElement("div");
    el.className = `grid-splitter grid-splitter-${axis}`;
    el.setAttribute("role", "separator");
    el.setAttribute(
      "aria-orientation",
      axis === "col" ? "vertical" : "horizontal",
    );
    if (axis === "col") el.style.left = `${cumFraction * 100}%`;
    else el.style.top = `${cumFraction * 100}%`;
    el.addEventListener("mousedown", (e) => this.startDrag(e, axis, boundary));
    return el;
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
    const drag = this.drag;
    const container = this.container;
    if (!drag || !container) return;
    const rect = container.getBoundingClientRect();
    if (drag.axis === "col" && rect.width > 0) {
      const target = (this.dragPointer.x - rect.left) / rect.width;
      this.model = {
        ...this.model,
        colSizes: resizeTrack(this.model.colSizes, drag.boundary, target),
      };
    } else if (drag.axis === "row" && rect.height > 0) {
      const target = (this.dragPointer.y - rect.top) / rect.height;
      this.model = {
        ...this.model,
        rowSizes: resizeTrack(this.model.rowSizes, drag.boundary, target),
      };
    }
    this.applyLayout();
    // Re-fit visually (once per frame); resize_pty is held until drag end.
    for (const cell of this.cells) cell.pane.fit();
  };

  private onDragEnd = (): void => {
    window.removeEventListener("mousemove", this.onDragMove);
    window.removeEventListener("mouseup", this.onDragEnd);
    if (this.dragRaf !== 0) {
      cancelAnimationFrame(this.dragRaf);
      this.dragRaf = 0;
    }
    document.body.classList.remove("grid-dragging-col", "grid-dragging-row");
    this.drag = null;
    for (const cell of this.cells) cell.pane.setResizeThrottled(false);
    // Push the final size to every live session's PTY exactly once.
    for (const cell of this.cells) cell.pane.syncSize();
    // Splitter sizes are part of the saved-state → may now differ from profile.
    this.emitChange();
  };

  /**
   * Full teardown: disposes every pane (which closes any live backend session)
   * and removes the grid-level drag listeners.
   *
   * NOTE: app-close clean disconnect (SPEC §7) is handled on the *backend* — a
   * Tauri `CloseRequested` handler calls `SessionManager::disconnect_all()`
   * before the window is destroyed (see `src-tauri/src/lib.rs`), which is robust
   * even if the webview is already tearing down. This frontend `dispose()` is
   * retained for a future Vite HMR dispose hook and is exercised by
   * `grid.test.ts`; it is not currently wired to a lifecycle event.
   */
  dispose(): void {
    window.removeEventListener("mousemove", this.onDragMove);
    window.removeEventListener("mouseup", this.onDragEnd);
    if (this.dragRaf !== 0) {
      cancelAnimationFrame(this.dragRaf);
      this.dragRaf = 0;
    }
    for (const cell of this.cells) {
      cell.pane.dispose();
      cell.wrapper.remove();
    }
    this.cells = [];
  }
}
