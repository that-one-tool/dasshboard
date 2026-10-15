import { describe, it, expect } from "vitest";
import type { SftpEntry } from "../../ipc";
import { EntrySelection } from "./entrySelection";

const entries = ["a", "b", "c", "d"].map((name) => ({ name, kind: "file", size: 0 }) as SftpEntry);

describe("EntrySelection", () => {
  it("toggles one entry on and off", () => {
    const selection = new EntrySelection();
    selection.toggle(entries, 1, false);
    expect(selection.has("b")).toBe(true);
    selection.toggle(entries, 1, false);
    expect(selection.size).toBe(0);
  });

  it("shift-selects the range from the last toggled entry", () => {
    const selection = new EntrySelection();
    selection.toggle(entries, 3, false);
    selection.toggle(entries, 1, true);
    expect(selection.names()).toEqual(["d", "b", "c"]);
  });

  it("a shift-click with no earlier click toggles just that entry", () => {
    const selection = new EntrySelection();
    selection.toggle(entries, 2, true);
    expect(selection.names()).toEqual(["c"]);
  });

  it("selects every entry, or clears when all are selected", () => {
    const selection = new EntrySelection();
    selection.toggleAll(entries);
    expect(selection.size).toBe(4);
    expect(selection.allSelected(entries)).toBe(true);
    selection.toggleAll(entries);
    expect(selection.size).toBe(0);
  });

  it("select-all forgets the range anchor", () => {
    const selection = new EntrySelection();
    selection.toggle(entries, 0, false);
    selection.toggleAll(entries);
    selection.toggleAll(entries);
    selection.toggle(entries, 2, true);
    expect(selection.names()).toEqual(["c"]);
  });

  it("forgetting the anchor keeps the selection", () => {
    const selection = new EntrySelection();
    selection.toggle(entries, 0, false);
    selection.forgetAnchor();
    selection.toggle(entries, 2, true);
    expect(selection.names()).toEqual(["a", "c"]);
  });

  it("resolves the selected names against a listing, in listing order", () => {
    const selection = new EntrySelection();
    selection.toggle(entries, 2, false);
    selection.toggle(entries, 0, false);
    expect(selection.selectedIn(entries).map((e) => e.name)).toEqual(["a", "c"]);
  });

  it("an empty listing is never all selected", () => {
    expect(new EntrySelection().allSelected([])).toBe(false);
  });

  it("clear drops the selection and the anchor", () => {
    const selection = new EntrySelection();
    selection.toggle(entries, 0, false);
    selection.clear();
    selection.toggle(entries, 2, true);
    expect(selection.names()).toEqual(["c"]);
  });
});
