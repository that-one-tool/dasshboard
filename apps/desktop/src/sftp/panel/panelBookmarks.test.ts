/** @vitest-environment happy-dom */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ saved: [] as string[] }));

vi.mock("../../ipc", () => ({
  sftpBookmarks: vi.fn(async () => h.saved),
  sftpBookmarkAdd: vi.fn(async (_id: string, path: string) => [...h.saved, path]),
  sftpBookmarkRemove: vi.fn(async (_id: string, path: string) => h.saved.filter((p) => p !== path)),
}));

import { sftpBookmarkAdd, sftpBookmarkRemove, sftpBookmarks } from "../../ipc";
import { PanelBookmarks } from "./panelBookmarks";
import { buildPanelElements } from "./panelElements";
import { PanelSession } from "./panelSession";
import { PanelFeedback } from "./panelFeedback";

function setup(cwd = "/home/j") {
  const els = buildPanelElements(document.createElement("aside"));
  const session = new PanelSession();
  session.markConnected("a");
  const hooks = { notifyError: vi.fn(), notifySuccess: vi.fn(), resync: vi.fn() };
  const bookmarks = new PanelBookmarks({
    els: () => els,
    session,
    feedback: new PanelFeedback(hooks),
    cwd: () => cwd,
  });
  return { els, session, hooks, bookmarks };
}

function chipPaths(els: { bookmarks: HTMLElement }): (string | undefined)[] {
  return [...els.bookmarks.querySelectorAll<HTMLElement>(".sftp-bookmark-go")].map((chip) => chip.dataset.path);
}

describe("PanelBookmarks", () => {
  beforeEach(() => {
    h.saved = ["/etc", "/home/j"];
    vi.clearAllMocks();
  });

  it("loads and renders a device's bookmarks, marking the current directory", async () => {
    const { els, bookmarks } = setup();
    await bookmarks.load("a");
    expect(sftpBookmarks).toHaveBeenCalledWith("a");
    expect(chipPaths(els)).toEqual(["/etc", "/home/j"]);
    expect(els.bookmarkToggle.classList.contains("is-marked")).toBe(true);
  });

  it("leaves the bar empty when loading fails", async () => {
    vi.mocked(sftpBookmarks).mockRejectedValueOnce(new Error("io"));
    const { els, bookmarks } = setup();
    await bookmarks.load("a");
    expect(els.bookmarks.hidden).toBe(true);
  });

  it("hides the chips while disconnected", async () => {
    const { els, session, bookmarks } = setup();
    await bookmarks.load("a");
    session.markDisconnected();
    bookmarks.render();
    expect(chipPaths(els)).toEqual([]);
    expect(els.bookmarkToggle.classList.contains("is-marked")).toBe(false);
  });

  it("clear forgets them", async () => {
    const { els, bookmarks } = setup();
    await bookmarks.load("a");
    bookmarks.clear();
    expect(chipPaths(els)).toEqual([]);
  });

  it("toggle adds the current directory, or removes it when bookmarked", async () => {
    const added = setup("/srv");
    await added.bookmarks.load("a");
    await added.bookmarks.toggle();
    expect(sftpBookmarkAdd).toHaveBeenCalledWith("a", "/srv");
    expect(chipPaths(added.els)).toContain("/srv");

    const removed = setup("/etc");
    await removed.bookmarks.load("a");
    await removed.bookmarks.toggle();
    expect(sftpBookmarkRemove).toHaveBeenCalledWith("a", "/etc");
    expect(chipPaths(removed.els)).toEqual(["/home/j"]);
  });

  it("remove drops one chip", async () => {
    const { els, bookmarks } = setup();
    await bookmarks.load("a");
    await bookmarks.remove("/etc");
    expect(chipPaths(els)).toEqual(["/home/j"]);
  });

  it("does nothing while disconnected", async () => {
    const { session, bookmarks } = setup();
    session.markDisconnected();
    await bookmarks.toggle();
    await bookmarks.remove("/etc");
    expect(sftpBookmarkAdd).not.toHaveBeenCalled();
    expect(sftpBookmarkRemove).not.toHaveBeenCalled();
  });

  it("reports a failed save", async () => {
    vi.mocked(sftpBookmarkAdd).mockRejectedValueOnce({ code: "Io", message: "disk full" });
    const { hooks, bookmarks } = setup("/srv");
    await bookmarks.toggle();
    expect(hooks.notifyError).toHaveBeenCalledWith({ code: "Io", message: "disk full" });
  });
});
