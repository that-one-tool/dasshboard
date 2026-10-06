/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi } from "vitest";
import { renderEditList } from "./editList";
import type { EditEntry } from "./editSessions";

function entry(editId: string, status: EditEntry["status"]): EditEntry {
  return {
    info: { editId, deviceId: "d1", remotePath: `/etc/${editId}.conf`, name: `${editId}.conf` },
    status,
  };
}

function setup(entries: EditEntry[]) {
  const container = document.createElement("div");
  const actions = { onReopen: vi.fn(), onStop: vi.fn() };
  renderEditList(container, entries, actions);
  return { container, actions };
}

describe("renderEditList", () => {
  it("hides itself when nothing is being edited", () => {
    const { container } = setup([]);
    expect(container.hidden).toBe(true);
    expect(container.querySelectorAll(".sftp-edit-row")).toHaveLength(0);
  });

  it("lists each edit with its name, remote path and status", () => {
    const { container } = setup([entry("a", "synced"), entry("b", "pending")]);

    expect(container.hidden).toBe(false);
    expect(container.querySelector(".sftp-edits-title")?.textContent).toBe("Synced with the server");
    expect(container.querySelector(".sftp-edits-hint")?.textContent).toBe(
      "Saves keep uploading until you click ×.",
    );
    const rows = container.querySelectorAll<HTMLElement>(".sftp-edit-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector(".sftp-edit-name")?.textContent).toBe("a.conf");
    expect(rows[0]?.querySelector(".sftp-edit-name")?.getAttribute("title")).toContain("/etc/a.conf");
    expect(rows[0]?.querySelector(".sftp-edit-status")?.textContent).toBe("Up to date");
    expect(rows[1]?.classList.contains("is-pending")).toBe(true);
    expect(rows[1]?.querySelector(".sftp-edit-status")?.textContent).toBe("Not uploaded");
  });

  it("reopens the editor from the name and stops from the stop button", () => {
    const { container, actions } = setup([entry("a", "syncing")]);

    container.querySelector<HTMLElement>(".sftp-edit-name")?.click();
    container.querySelector<HTMLElement>(".sftp-edit-stop")?.click();

    expect(actions.onReopen).toHaveBeenCalledWith("a");
    expect(actions.onStop).toHaveBeenCalledWith("a");
  });

  it("replaces the previous rows on re-render", () => {
    const container = document.createElement("div");
    const actions = { onReopen: vi.fn(), onStop: vi.fn() };
    renderEditList(container, [entry("a", "synced"), entry("b", "synced")], actions);
    renderEditList(container, [entry("b", "synced")], actions);
    expect(container.querySelectorAll(".sftp-edit-row")).toHaveLength(1);
  });
});
