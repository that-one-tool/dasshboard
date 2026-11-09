/** @vitest-environment happy-dom */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SftpEntry } from "../../ipc";

const h = vi.hoisted(() => ({ listing: [] as SftpEntry[] }));

vi.mock("../../ipc", () => ({
  sftpList: vi.fn(async () => h.listing),
  sftpRealpath: vi.fn(async (_id: string, path: string) => {
    const stack: string[] = [];
    for (const segment of path.split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") stack.pop();
      else stack.push(segment);
    }
    return "/" + stack.join("/");
  }),
}));

import { sftpList, sftpRealpath } from "../../ipc";
import { t } from "../../i18n";
import { DirectoryBrowser } from "./directoryBrowser";
import { DirHistory } from "./dirHistory";
import { EntryList } from "./entryList";
import { PanelControls } from "./panelControls";
import { buildPanelElements } from "./panelElements";
import { PanelFeedback } from "./panelFeedback";
import { PanelSession } from "./panelSession";
import type { EntryRowActions } from "./entryRow";

function setup() {
  const els = buildPanelElements(document.createElement("aside"));
  const session = new PanelSession();
  session.markConnected("a");
  const history = new DirHistory();
  const controls = new PanelControls(() => els, session, history);
  const list = new EntryList({ els: () => els, rowActions: { isBusy: () => false } as EntryRowActions, canPaste: () => false });
  const hooks = { notifyError: vi.fn(), notifySuccess: vi.fn(), resync: vi.fn() };
  const onListed = vi.fn();
  const browser = new DirectoryBrowser({
    els: () => els,
    session,
    controls,
    history,
    list,
    feedback: new PanelFeedback(hooks),
    onListed,
  });
  return { els, session, controls, history, list, hooks, onListed, browser };
}

function names(els: { list: HTMLElement }): (string | null)[] {
  return [...els.list.querySelectorAll(".sftp-entry-name")].map((e) => e.textContent);
}

describe("DirectoryBrowser", () => {
  beforeEach(() => {
    h.listing = [
      { name: "b.txt", kind: "file", size: 2 },
      { name: "a.txt", kind: "file", size: 1 },
    ];
    vi.clearAllMocks();
  });

  it("lists a directory: renders it, shows the path and the count", async () => {
    const { els, controls, onListed, browser } = setup();
    expect(await browser.loadDir("/home")).toBe(true);
    expect(browser.cwd()).toBe("/home");
    expect(els.path.value).toBe("/home");
    expect(names(els)).toEqual(["a.txt", "b.txt"]);
    expect(els.status.textContent).toBe(t("sftp.count.other", { count: 2 }));
    expect(onListed).toHaveBeenCalled();
    expect(controls.isBusy()).toBe(false);
  });

  it("does nothing while disconnected", async () => {
    const { session, browser } = setup();
    session.markDisconnected();
    expect(await browser.loadDir("/home")).toBe(false);
    expect(browser.place()).toBeNull();
    expect(sftpList).not.toHaveBeenCalled();
  });

  it("reports a failed listing and stays put", async () => {
    const { hooks, browser } = setup();
    await browser.loadDir("/home");
    vi.mocked(sftpList).mockRejectedValueOnce({ code: "Sftp", message: "denied" });
    expect(await browser.loadDir("/root")).toBe(false);
    expect(browser.cwd()).toBe("/home");
    expect(hooks.notifyError).toHaveBeenCalledWith({ code: "Sftp", message: "denied" });
  });

  it("drops a listing, and its error, once the device changed", async () => {
    const { session, hooks, browser } = setup();
    vi.mocked(sftpList).mockImplementationOnce(async () => {
      session.markConnected("b");
      return h.listing;
    });
    expect(await browser.loadDir("/home")).toBe(false);
    expect(browser.cwd()).toBe("/");

    vi.mocked(sftpList).mockImplementationOnce(async () => {
      session.markDisconnected();
      throw new Error("gone");
    });
    expect(await browser.loadDir("/home")).toBe(false);
    expect(hooks.notifyError).not.toHaveBeenCalled();
  });

  it("keeps the filter on a re-list and clears it on navigation", async () => {
    const { els, browser } = setup();
    await browser.loadDir("/home");
    els.filter.value = "a";
    browser.setFilter("a");
    expect(names(els)).toEqual(["a.txt"]);
    await browser.reload();
    expect(names(els)).toEqual(["a.txt"]);
    await browser.loadDir("/etc");
    expect(els.filter.value).toBe("");
    expect(names(els)).toEqual(["a.txt", "b.txt"]);
  });

  it("filtering drops the selection; sorting keeps it", async () => {
    const { list, browser } = setup();
    await browser.loadDir("/home");
    list.toggleCheck(0, false);
    browser.setSort("size");
    expect(list.selection.size).toBe(1);
    browser.setFilter("b");
    expect(list.selection.size).toBe(0);
  });

  it("marks the active sort column with an arrow and aria-sort", async () => {
    const { els, browser } = setup();
    await browser.loadDir("/home");
    const header = (key: string) => els.root.querySelector<HTMLButtonElement>(`[data-sort="${key}"]`);
    expect(header("name")?.textContent).toBe("Name ▲");
    expect(header("name")?.getAttribute("aria-sort")).toBe("ascending");

    browser.setSort("size");
    browser.setSort("size");
    expect(header("size")?.textContent).toBe("Size ▼");
    expect(header("size")?.getAttribute("aria-sort")).toBe("descending");
    expect(header("size")?.classList.contains("is-active")).toBe(true);
    expect(header("name")?.textContent).toBe("Name");
    expect(header("name")?.getAttribute("aria-sort")).toBe("none");
    expect(header("name")?.classList.contains("is-active")).toBe(false);
  });

  it("isAt holds for the place on screen", async () => {
    const { browser } = setup();
    await browser.loadDir("/home");
    const place = browser.place();
    expect(place).toEqual({ deviceId: "a", dir: "/home" });
    expect(place && browser.isAt(place)).toBe(true);
  });

  it("isAt fails once another device is connected", async () => {
    const { session, browser } = setup();
    await browser.loadDir("/home");
    session.markConnected("b");
    expect(browser.isAt({ deviceId: "a", dir: "/home" })).toBe(false);
    session.markDisconnected();
    expect(browser.isAt({ deviceId: "a", dir: "/home" })).toBe(false);
  });

  it("isAt fails once another directory is listed", async () => {
    const { browser } = setup();
    await browser.loadDir("/home");
    await browser.loadDir("/etc");
    expect(browser.isAt({ deviceId: "a", dir: "/home" })).toBe(false);
    expect(browser.isAt({ deviceId: "a", dir: "/etc" })).toBe(true);
  });

  it("goTo records history; Back and Forward revisit without recording", async () => {
    const { els, history, browser } = setup();
    await browser.goTo("/a");
    await browser.goTo("/b");
    await browser.goTo("/b");
    expect(els.back.disabled).toBe(false);
    await browser.goBack();
    expect(browser.cwd()).toBe("/a");
    expect(history.canGoForward()).toBe(true);
    await browser.goForward();
    expect(browser.cwd()).toBe("/b");
    expect(history.canGoForward()).toBe(false);
  });

  it("goUp opens the resolved parent, and stays at the root", async () => {
    const { browser } = setup();
    await browser.goTo("/home/j");
    await browser.goUp();
    expect(browser.cwd()).toBe("/home");
    await browser.goTo("/");
    vi.mocked(sftpList).mockClear();
    await browser.goUp();
    expect(sftpList).not.toHaveBeenCalled();
  });

  it("goUp reports a parent that can't be resolved", async () => {
    const { hooks, browser } = setup();
    vi.mocked(sftpRealpath).mockRejectedValueOnce({ code: "Sftp", message: "gone" });
    await browser.goUp();
    expect(hooks.notifyError).toHaveBeenCalled();
  });

  it("goToPath opens a typed folder, or a typed file's parent", async () => {
    const { browser } = setup();
    await browser.goToPath(" /var/log/../tmp ");
    expect(browser.cwd()).toBe("/var/tmp");
    vi.mocked(sftpList).mockRejectedValueOnce(new Error("not a directory"));
    await browser.goToPath("/etc/hosts");
    expect(browser.cwd()).toBe("/etc");
  });

  it("goToPath resets the input on an empty path or a failure", async () => {
    const { els, hooks, browser } = setup();
    await browser.loadDir("/home");
    els.path.value = "  ";
    await browser.goToPath("  ");
    expect(els.path.value).toBe("/home");

    vi.mocked(sftpRealpath).mockRejectedValueOnce({ code: "Sftp", message: "no such file" });
    els.path.value = "/nope";
    await browser.goToPath("/nope");
    expect(els.path.value).toBe("/home");
    expect(hooks.notifyError).toHaveBeenCalled();
    expect(browser.cwd()).toBe("/home");
  });

  it("refreshIfShowing re-lists only the idle listing on screen", async () => {
    const { controls, browser } = setup();
    await browser.loadDir("/home");
    vi.mocked(sftpList).mockClear();
    browser.refreshIfShowing("b", "/home");
    browser.refreshIfShowing("a", "/etc");
    controls.setBusy(true);
    browser.refreshIfShowing("a", "/home");
    expect(sftpList).not.toHaveBeenCalled();
    controls.setBusy(false);
    browser.refreshIfShowing("a", "/home");
    expect(sftpList).toHaveBeenCalledWith("a", "/home");
  });

  it("copyPath copies the directory when connected", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { session, hooks, browser } = setup();
    await browser.loadDir("/home");
    await browser.copyPath();
    expect(writeText).toHaveBeenCalledWith("/home");
    expect(hooks.notifySuccess).toHaveBeenCalledWith(t("sftp.pathCopied"));

    writeText.mockRejectedValueOnce(new Error("denied"));
    await browser.copyPath();
    expect(hooks.notifyError).toHaveBeenCalled();

    session.markDisconnected();
    await browser.copyPath();
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("showDisconnected says why per state, and empties the path", () => {
    const { els, session, browser } = setup();
    session.markDisconnected();
    const message = (): string | null | undefined => els.list.querySelector(".sftp-empty")?.textContent;
    browser.showDisconnected();
    expect(message()).toBe(t("sftp.pickDevice"));
    expect(els.path.value).toBe("");
    session.pickDevice("a");
    browser.showDisconnected();
    expect(message()).toBe(t("sftp.notConnected"));
    session.markIdleDisconnected();
    browser.showDisconnected();
    expect(message()).toBe(t("sftp.idleDisconnected"));
  });
});
