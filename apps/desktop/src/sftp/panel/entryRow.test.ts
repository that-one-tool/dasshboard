/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi } from "vitest";
import type { SftpEntry } from "../../ipc";
import { t } from "../../i18n";
import { formatSize } from "../sftpFormat";
import { renderEntryRow, type EntryRowActions } from "./entryRow";

function actions(busy = false): EntryRowActions {
  return {
    isBusy: () => busy,
    onCheck: vi.fn(),
    onOpen: vi.fn(),
    onDownload: vi.fn(),
    onEdit: vi.fn(),
    onRename: vi.fn(),
    onPermissions: vi.fn(),
    onDelete: vi.fn(),
  };
}

const file: SftpEntry = { name: "a.txt", kind: "file", size: 2048, mode: 0o644, modified: 0 } as SftpEntry;
const dir: SftpEntry = { name: "src", kind: "dir", size: 0, mode: 0o755 } as SftpEntry;
const link: SftpEntry = { name: "ln", kind: "symlink", size: 0, mode: 0o777 } as SftpEntry;

const button = (row: HTMLElement, label: string) =>
  row.querySelector<HTMLButtonElement>(`.sftp-entry-actions [aria-label="${label}"]`);

describe("renderEntryRow", () => {
  it("shows the name as text, with its kind class and checkbox state", () => {
    const row = renderEntryRow({ ...file, name: "<i>x</i>" }, 0, true, actions());
    expect(row.classList.contains("is-file")).toBe(true);
    expect(row.querySelector(".sftp-entry-name")?.textContent).toBe("<i>x</i>");
    expect(row.querySelector<HTMLInputElement>(".sftp-entry-check")?.checked).toBe(true);
  });

  it("reports a checkbox click with its index and shift state", () => {
    const acts = actions();
    const row = renderEntryRow(file, 3, false, acts);
    row.querySelector<HTMLInputElement>(".sftp-entry-check")?.dispatchEvent(new MouseEvent("click", { shiftKey: true }));
    expect(acts.onCheck).toHaveBeenCalledWith(3, true);
  });

  it("opens an entry from its name, unless busy", () => {
    const idle = actions();
    renderEntryRow(dir, 0, false, idle).querySelector<HTMLElement>(".sftp-entry-name")?.click();
    expect(idle.onOpen).toHaveBeenCalledWith(dir);
    const busy = actions(true);
    renderEntryRow(dir, 0, false, busy).querySelector<HTMLElement>(".sftp-entry-name")?.click();
    expect(busy.onOpen).not.toHaveBeenCalled();
  });

  it("offers edit on files only, and permissions on anything but a symlink", () => {
    const fileRow = renderEntryRow(file, 0, false, actions());
    const dirRow = renderEntryRow(dir, 0, false, actions());
    const linkRow = renderEntryRow(link, 0, false, actions());
    expect(button(fileRow, t("sftp.entry.edit"))).not.toBeNull();
    expect(button(dirRow, t("sftp.entry.edit"))).toBeNull();
    expect(button(dirRow, t("sftp.entry.permissions"))).not.toBeNull();
    expect(button(linkRow, t("sftp.entry.permissions"))).toBeNull();
  });

  it("offers no permissions when the server reported no mode", () => {
    const row = renderEntryRow({ ...file, mode: undefined }, 0, false, actions());
    expect(button(row, t("sftp.entry.permissions"))).toBeNull();
  });

  it("routes each action button to its handler, unless busy", () => {
    const acts = actions();
    const row = renderEntryRow(file, 0, false, acts);
    button(row, t("sftp.entry.download"))?.click();
    button(row, t("sftp.entry.edit"))?.click();
    button(row, t("sftp.entry.rename"))?.click();
    button(row, t("sftp.entry.permissions"))?.click();
    button(row, t("sftp.entry.delete"))?.click();
    for (const handler of [acts.onDownload, acts.onEdit, acts.onRename, acts.onPermissions, acts.onDelete]) {
      expect(handler).toHaveBeenCalledWith(file);
    }
    const busy = actions(true);
    button(renderEntryRow(file, 0, false, busy), t("sftp.entry.delete"))?.click();
    expect(busy.onDelete).not.toHaveBeenCalled();
  });

  it("shows a file's size but not a folder's", () => {
    const fileMeta = renderEntryRow(file, 0, false, actions()).querySelector(".sftp-entry-meta")?.textContent;
    const dirMeta = renderEntryRow(dir, 0, false, actions()).querySelector(".sftp-entry-meta")?.textContent;
    expect(fileMeta).toContain(formatSize(2048));
    expect(dirMeta).not.toContain(formatSize(0));
  });

  it("tracks hover in script, so a native dialog can't leave it stuck", () => {
    const row = renderEntryRow(file, 0, false, actions());
    row.dispatchEvent(new MouseEvent("mouseenter"));
    expect(row.classList.contains("hovering")).toBe(true);
    row.dispatchEvent(new MouseEvent("mouseleave"));
    expect(row.classList.contains("hovering")).toBe(false);
  });
});
