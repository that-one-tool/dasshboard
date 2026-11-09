/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { presetToModel, type GridModel } from "../gridModel";
import { draggedModel, layoutGrid } from "./gridSplitters";

let container: HTMLElement;
const onGrab = vi.fn();

beforeEach(() => {
  container = document.createElement("div");
  onGrab.mockReset();
});

function splitters(axis: "col" | "row"): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(`.grid-splitter-${axis}`)];
}

const twoByTwo = (): GridModel => ({ rows: 2, cols: 2, rowSizes: [0.25, 0.75], colSizes: [0.5, 0.5] });

describe("layoutGrid", () => {
  it("sets the track templates and one splitter per inner boundary", () => {
    layoutGrid(container, twoByTwo(), onGrab);
    expect(container.style.gridTemplateColumns).toBe("0.5fr 0.5fr");
    expect(container.style.gridTemplateRows).toBe("0.25fr 0.75fr");
    expect(splitters("col")).toHaveLength(1);
    expect(splitters("row")).toHaveLength(1);
    expect(splitters("col")[0]?.style.left).toBe("50%");
    expect(splitters("row")[0]?.style.top).toBe("25%");
    expect(splitters("col")[0]?.getAttribute("aria-orientation")).toBe("vertical");
    expect(splitters("row")[0]?.getAttribute("role")).toBe("separator");
  });

  it("moves existing splitters in place when the shape is unchanged", () => {
    layoutGrid(container, twoByTwo(), onGrab);
    const before = splitters("col")[0];
    layoutGrid(container, { ...twoByTwo(), colSizes: [0.75, 0.25] }, onGrab);
    expect(splitters("col")[0]).toBe(before);
    expect(before?.style.left).toBe("75%");
  });

  it("rebuilds the splitters when the shape changes", () => {
    layoutGrid(container, twoByTwo(), onGrab);
    layoutGrid(container, presetToModel("1x1"), onGrab);
    expect(container.querySelectorAll(".grid-splitter")).toHaveLength(0);
  });

  it("reports a grabbed splitter's axis and boundary", () => {
    layoutGrid(container, { rows: 3, cols: 1, rowSizes: [0.3, 0.3, 0.4], colSizes: [1] }, onGrab);
    splitters("row")[1]?.dispatchEvent(new MouseEvent("mousedown"));
    expect(onGrab).toHaveBeenCalledWith(expect.any(MouseEvent), "row", 1);
  });
});

describe("draggedModel", () => {
  const rect = { left: 100, top: 0, width: 200, height: 400 } as DOMRect;

  it("moves a column boundary under the pointer", () => {
    const next = draggedModel(twoByTwo(), { axis: "col", boundary: 0 }, { x: 250, y: 0 }, rect);
    expect(next.colSizes[0]).toBeCloseTo(0.75);
    expect(next.rowSizes).toEqual([0.25, 0.75]);
  });

  it("moves a row boundary under the pointer", () => {
    const next = draggedModel(twoByTwo(), { axis: "row", boundary: 0 }, { x: 0, y: 200 }, rect);
    expect(next.rowSizes[0]).toBeCloseTo(0.5);
    expect(next.colSizes).toEqual([0.5, 0.5]);
  });

  it("leaves the model alone while the grid has no size", () => {
    const model = twoByTwo();
    const empty = { left: 0, top: 0, width: 0, height: 0 } as DOMRect;
    expect(draggedModel(model, { axis: "col", boundary: 0 }, { x: 5, y: 5 }, empty)).toBe(model);
  });
});
