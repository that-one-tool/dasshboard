/** The grid's CSS track sizes and its splitter overlay, plus the track resize
 * a splitter drag asks for. */

import { cumulativeFractions, resizeTrack, type GridModel } from "../gridModel";

export type DragAxis = "col" | "row";

export interface SplitterDrag {
  axis: DragAxis;
  boundary: number;
}

/** A pressed splitter: start dragging `boundary` along `axis`. */
export type SplitterGrab = (e: MouseEvent, axis: DragAxis, boundary: number) => void;

interface AxisGeometry {
  sizes: "colSizes" | "rowSizes";
  pointer: "x" | "y";
  start: "left" | "top";
  length: "width" | "height";
  splitterClass: string;
  orientation: string;
}

const AXES: Record<DragAxis, AxisGeometry> = {
  col: { sizes: "colSizes", pointer: "x", start: "left", length: "width", splitterClass: "grid-splitter-col", orientation: "vertical" },
  row: { sizes: "rowSizes", pointer: "y", start: "top", length: "height", splitterClass: "grid-splitter-row", orientation: "horizontal" },
};

const AXIS_ORDER: DragAxis[] = ["col", "row"];

/**
 * Applies the model's track sizes to the grid, then updates the splitter
 * overlay. A splitter drag calls this every animation frame with the track
 * *count* unchanged (only sizes move) — rebuilding every splitter node on each
 * tick would churn the DOM up to 60x/sec and drop `:hover`/`:active` state on
 * the dragged splitter. So the splitter count per axis is checked first:
 * unchanged ⇒ reposition the existing nodes in place (cheap, keeps their
 * listeners); changed (a preset/profile switch) ⇒ full rebuild.
 */
export function layoutGrid(container: HTMLElement, model: GridModel, onGrab: SplitterGrab): void {
  container.style.gridTemplateColumns = trackTemplate(model.colSizes);
  container.style.gridTemplateRows = trackTemplate(model.rowSizes);
  if (splitterShapeMatches(container, model)) repositionSplitters(container, model);
  else rebuildSplitters(container, model, onGrab);
}

function trackTemplate(sizes: number[]): string {
  return sizes.map((fraction) => `${fraction}fr`).join(" ");
}

/** True when the DOM already has exactly the col/row splitter count the model needs. */
function splitterShapeMatches(container: HTMLElement, model: GridModel): boolean {
  return AXIS_ORDER.every((axis) => splitterCountMatches(container, model, axis));
}

function splitterCountMatches(container: HTMLElement, model: GridModel, axis: DragAxis): boolean {
  const { sizes, splitterClass } = AXES[axis];
  const expected = Math.max(0, model[sizes].length - 1);
  return container.querySelectorAll(`.${splitterClass}`).length === expected;
}

/** Moves existing splitter nodes to the current boundary fractions, in place. */
function repositionSplitters(container: HTMLElement, model: GridModel): void {
  for (const axis of AXIS_ORDER) {
    const { sizes, splitterClass, start } = AXES[axis];
    const splitters = container.querySelectorAll<HTMLElement>(`.${splitterClass}`);
    cumulativeFractions(model[sizes]).forEach((fraction, i) => {
      const splitter = splitters[i];
      if (splitter) splitter.style[start] = percent(fraction);
    });
  }
}

/** Removes and recreates every splitter (cells are left untouched). */
function rebuildSplitters(container: HTMLElement, model: GridModel, onGrab: SplitterGrab): void {
  for (const splitter of container.querySelectorAll(".grid-splitter")) splitter.remove();
  for (const axis of AXIS_ORDER) {
    cumulativeFractions(model[AXES[axis].sizes]).forEach((fraction, boundary) => {
      container.appendChild(createSplitter(axis, boundary, fraction, onGrab));
    });
  }
}

function createSplitter(axis: DragAxis, boundary: number, fraction: number, onGrab: SplitterGrab): HTMLElement {
  const { splitterClass, orientation, start } = AXES[axis];
  const splitter = document.createElement("div");
  splitter.className = `grid-splitter ${splitterClass}`;
  splitter.setAttribute("role", "separator");
  splitter.setAttribute("aria-orientation", orientation);
  splitter.style[start] = percent(fraction);
  splitter.addEventListener("mousedown", (e) => onGrab(e, axis, boundary));
  return splitter;
}

function percent(fraction: number): string {
  return `${fraction * 100}%`;
}

/** The model with the dragged boundary moved under the pointer; unchanged
 * while the grid has no size on that axis. */
export function draggedModel(
  model: GridModel,
  drag: SplitterDrag,
  pointer: { x: number; y: number },
  rect: DOMRect,
): GridModel {
  const { sizes, pointer: coordinate, start, length } = AXES[drag.axis];
  if (!(rect[length] > 0)) return model;
  const target = (pointer[coordinate] - rect[start]) / rect[length];
  return { ...model, [sizes]: resizeTrack(model[sizes], drag.boundary, target) };
}
