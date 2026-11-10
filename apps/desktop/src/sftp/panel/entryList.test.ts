/** @vitest-environment happy-dom */
import { describe, it, expect, vi } from "vitest";
import type { SftpEntry } from "../../ipc";
import { EntryList } from "./entryList";
import type { EntryRowActions } from "./entryRow";
import { buildPanelElements } from "./panelElements";

const entries: SftpEntry[] = [
  { name: "sub", kind: "dir", size: 0 },
  { name: "a.txt", kind: "file", size: 1 },
  { name: "b.txt", kind: "file", size: 2 },
];

function rowActions(): EntryRowActions {
  return {
    isBusy: () => false,
    onCheck: vi.fn(),
    onOpen: vi.fn(),
    onDownload: vi.fn(),
    onEdit: vi.fn(),
    onRename: vi.fn(),
    onPermissions: vi.fn(),
    onDelete: vi.fn(),
  };
}

function setup(canPaste = false) {
  const els = buildPanelElements(document.createElement("aside"));
  const list = new EntryList({ els: () => els, rowActions: rowActions(), canPaste: () => canPaste });
  return { els, list };
}

function checks(root: HTMLElement): boolean[] {
  return [...root.querySelectorAll<HTMLInputElement>(".sftp-entry-check")].map((box) => box.checked);
}

describe("EntryList", () => {
  it("renders one row per entry and shows the bulk bar", () => {
    const { els, list } = setup();
    list.render(entries);
    expect(els.list.querySelectorAll(".sftp-entry").length).toBe(3);
    expect(els.bulkBar.hidden).toBe(false);
    expect(list.names()).toEqual(["sub", "a.txt", "b.txt"]);
  });

  it("says so when the directory is empty", () => {
    const { els, list } = setup();
    list.render([]);
    expect(els.list.querySelector(".sftp-empty")).not.toBeNull();
  });

  it("toggles checks, ranges with shift, and counts the selection", () => {
    const { els, list } = setup();
    list.render(entries);
    list.toggleCheck(0, false);
    list.toggleCheck(2, true);
    expect(checks(els.list)).toEqual([true, true, true]);
    expect(list.selected().map((entry) => entry.name)).toEqual(["sub", "a.txt", "b.txt"]);
    expect(els.selCount.textContent).toBe("3 selected");
    expect(els.selectAll.checked).toBe(true);
  });

  it("marks select-all indeterminate for a partial selection", () => {
    const { els, list } = setup();
    list.render(entries);
    list.toggleCheck(1, false);
    expect(els.selectAll.checked).toBe(false);
    expect(els.selectAll.indeterminate).toBe(true);
  });

  it("toggleAll selects everything, then nothing; clearSelection empties it", () => {
    const { els, list } = setup();
    list.render(entries);
    list.toggleAll();
    expect(checks(els.list)).toEqual([true, true, true]);
    list.toggleAll();
    expect(checks(els.list)).toEqual([false, false, false]);
    list.toggleCheck(1, false);
    list.clearSelection();
    expect(list.selected()).toEqual([]);
    expect(els.selCount.textContent).toBe("Select all");
  });

  it("enables the bulk actions only with a selection", () => {
    const { els, list } = setup();
    list.render(entries);
    const remove = els.bulkBar.querySelector<HTMLButtonElement>('[data-action="bulk-delete"]');
    expect(remove?.disabled).toBe(true);
    list.toggleCheck(0, false);
    expect(remove?.disabled).toBe(false);
  });

  it("shows Paste only when a move can land here", () => {
    const hidden = setup(false);
    hidden.list.render(entries);
    expect(hidden.els.pasteBtn.hidden).toBe(true);
    const shown = setup(true);
    shown.list.render(entries);
    expect(shown.els.pasteBtn.hidden).toBe(false);
    expect(shown.els.pasteBtn.disabled).toBe(false);
  });

  it("renders the disconnected notice and drops the listing", () => {
    const { els, list } = setup();
    list.render(entries);
    list.toggleCheck(0, false);
    list.renderDisconnected("Pick a device");
    expect(els.list.querySelector(".sftp-disconnected .sftp-empty")?.textContent).toBe("Pick a device");
    expect(els.bulkBar.hidden).toBe(true);
    expect(list.names()).toEqual([]);
    expect(list.selection.size).toBe(0);
  });

  it("renderConnecting shows a spinner and the message instead of the rows", () => {
    const { els, list } = setup();
    list.render(entries);
    list.toggleCheck(0, false);
    list.renderConnecting("Connecting to Alpha…");
    expect(els.list.querySelector(".sftp-connecting .sftp-spinner")).not.toBeNull();
    expect(els.list.querySelector("[role]")).toBeNull();
    expect(list.isConnecting()).toBe(true);
    expect(els.list.querySelector(".sftp-connecting .sftp-empty")?.textContent).toBe("Connecting to Alpha…");
    expect(els.bulkBar.hidden).toBe(true);
    expect(list.names()).toEqual([]);
    expect(list.selection.size).toBe(0);
  });

  it("isConnecting is false once rows or another notice replace it", () => {
    const { list } = setup();
    expect(list.isConnecting()).toBe(false);
    list.renderConnecting("Connecting…");
    list.render(entries);
    expect(list.isConnecting()).toBe(false);
    list.renderConnecting("Connecting…");
    list.renderMessage("Could not open");
    expect(list.isConnecting()).toBe(false);
  });

  it("renderMessage shows only the message", () => {
    const { els, list } = setup();
    list.render(entries);
    list.renderMessage("Could not open");
    expect(els.list.querySelector(".sftp-empty")?.textContent).toBe("Could not open");
    expect(els.list.querySelectorAll(".sftp-entry")).toHaveLength(0);
    expect(els.bulkBar.hidden).toBe(true);
  });

  it("clears the hover flag from every row", () => {
    const { els, list } = setup();
    list.render(entries);
    els.list.querySelectorAll(".sftp-entry").forEach((row) => row.classList.add("hovering"));
    list.clearHover();
    expect(els.list.querySelector(".hovering")).toBeNull();
  });
});
