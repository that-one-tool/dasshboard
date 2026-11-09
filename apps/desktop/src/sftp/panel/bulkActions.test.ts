/** @vitest-environment happy-dom */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SftpEntry } from "../../ipc";

const h = vi.hoisted(() => ({
  dest: "C:/dl" as string | null,
  confirmed: true,
  localExists: false,
  choice: "overwrite" as "overwrite" | "skip" | "rename" | null,
}));

vi.mock("../../ipc", () => ({
  sftpRename: vi.fn(async () => {}),
  sftpRemove: vi.fn(async () => {}),
  sftpLocalExists: vi.fn(async () => h.localExists),
}));
vi.mock("../../ui/confirm", () => ({
  confirm: vi.fn(async () => h.confirmed),
  chooseConflict: vi.fn(async () => h.choice),
}));
vi.mock("../../ui/fileDialog", () => ({ pickDownloadDirPath: vi.fn(async () => h.dest) }));
vi.mock("@tauri-apps/api/path", () => ({ join: vi.fn(async (...parts: string[]) => parts.join("/")) }));

import { sftpRemove, sftpRename } from "../../ipc";
import { chooseConflict } from "../../ui/confirm";
import { t } from "../../i18n";
import { BulkActions } from "./bulkActions";
import { DirHistory } from "./dirHistory";
import { EntryList } from "./entryList";
import type { EntryRowActions } from "./entryRow";
import { MoveClipboard } from "./moveClipboard";
import { PanelControls } from "./panelControls";
import { buildPanelElements } from "./panelElements";
import { PanelFeedback } from "./panelFeedback";
import { PanelSession } from "./panelSession";
import type { DirectoryBrowser } from "./directoryBrowser";
import type { TransferActions } from "./transferActions";

const listing: SftpEntry[] = [
  { name: "sub", kind: "dir", size: 0 },
  { name: "f.txt", kind: "file", size: 1 },
];

function setup() {
  const els = buildPanelElements(document.createElement("aside"));
  const session = new PanelSession();
  session.markConnected("a");
  const clipboard = new MoveClipboard();
  const state = { dir: "/home" };
  const controls = new PanelControls(() => els, session, new DirHistory());
  const list = new EntryList({
    els: () => els,
    rowActions: { isBusy: () => false } as EntryRowActions,
    canPaste: () => clipboard.canPasteInto(session.activeDeviceId, state.dir),
  });
  const browser = {
    cwd: () => state.dir,
    place: () => (session.activeDeviceId ? { deviceId: session.activeDeviceId, dir: state.dir } : null),
    loadDir: vi.fn(async () => {
      controls.setBusy(false);
      return true;
    }),
  };
  const transfers = { refuseUnsafeNames: vi.fn(() => false), queueBulkItem: vi.fn() };
  const hooks = { notifyError: vi.fn(), notifySuccess: vi.fn(), resync: vi.fn() };
  const bulk = new BulkActions({
    session,
    browser: browser as unknown as DirectoryBrowser,
    list,
    controls,
    feedback: new PanelFeedback(hooks),
    transfers: transfers as unknown as TransferActions,
    clipboard,
  });
  list.render(listing);
  return { els, session, clipboard, state, list, browser, transfers, hooks, bulk };
}

describe("BulkActions", () => {
  beforeEach(() => {
    Object.assign(h, { dest: "C:/dl", confirmed: true, localExists: false, choice: "overwrite" });
    vi.clearAllMocks();
  });

  it("download queues every selected entry into the picked folder, then clears the selection", async () => {
    const { list, transfers, bulk } = setup();
    list.toggleAll();
    await bulk.download();
    expect(transfers.queueBulkItem).toHaveBeenCalledWith("a", "/home/sub", listing[0], "C:/dl/sub", "overwrite");
    expect(transfers.queueBulkItem).toHaveBeenCalledWith("a", "/home/f.txt", listing[1], "C:/dl/f.txt", "overwrite");
    expect(list.selection.size).toBe(0);
    expect(chooseConflict).not.toHaveBeenCalled();
  });

  it("download asks once on a clash, naming a single entry", async () => {
    h.localExists = true;
    h.choice = "rename";
    const { list, transfers, bulk } = setup();
    list.toggleCheck(1, false);
    await bulk.download();
    expect(chooseConflict).toHaveBeenCalledWith(t("sftp.conflict.message", { name: "f.txt" }));
    expect(transfers.queueBulkItem).toHaveBeenCalledWith("a", "/home/f.txt", listing[1], "C:/dl/f.txt", "rename");
  });

  it("download queues nothing without a selection, on a refused name or a cancelled dialog", async () => {
    const { list, transfers, bulk } = setup();
    await bulk.download();
    list.toggleAll();
    transfers.refuseUnsafeNames.mockReturnValueOnce(true);
    await bulk.download();
    h.dest = null;
    await bulk.download();
    h.dest = "C:/dl";
    h.localExists = true;
    h.choice = null;
    await bulk.download();
    expect(transfers.queueBulkItem).not.toHaveBeenCalled();
  });

  it("download queues nothing once another connection took over", async () => {
    h.localExists = true;
    const { session, list, transfers, bulk } = setup();
    list.toggleAll();
    vi.mocked(chooseConflict).mockImplementationOnce(async () => {
      session.markConnected("b");
      return "overwrite";
    });
    await bulk.download();
    expect(transfers.queueBulkItem).not.toHaveBeenCalled();
  });

  it("cut records the selection; paste moves it into another directory", async () => {
    const { els, state, list, browser, hooks, bulk } = setup();
    list.toggleCheck(1, false);
    bulk.cut();
    expect(els.status.textContent).toBe(t("sftp.cutNotice.one", { count: 1 }));
    expect(list.selection.size).toBe(0);

    state.dir = "/srv";
    list.render([]);
    expect(els.pasteBtn.hidden).toBe(false);
    await bulk.paste();
    expect(sftpRename).toHaveBeenCalledWith("a", "/home/f.txt", "/srv/f.txt");
    expect(browser.loadDir).toHaveBeenCalledWith("/srv");
    expect(hooks.notifySuccess).toHaveBeenCalledWith(t("sftp.moved.one", { count: 1 }));
  });

  it("cut does nothing without a selection", () => {
    const { clipboard, bulk } = setup();
    bulk.cut();
    expect(clipboard.pending()).toBeNull();
  });

  it("pasting where the cut came from just drops it", async () => {
    const { clipboard, list, bulk } = setup();
    list.toggleCheck(1, false);
    bulk.cut();
    await bulk.paste();
    expect(clipboard.pending()).toBeNull();
    expect(sftpRename).not.toHaveBeenCalled();
  });

  it("paste does nothing for another device's cut", async () => {
    const { session, clipboard, state, list, bulk } = setup();
    list.toggleCheck(1, false);
    bulk.cut();
    session.markConnected("b");
    state.dir = "/srv";
    await bulk.paste();
    expect(sftpRename).not.toHaveBeenCalled();
    expect(clipboard.pending()).not.toBeNull();
  });

  it("a move that clashes reports a partial result", async () => {
    const { els, state, list, hooks, bulk } = setup();
    list.toggleCheck(1, false);
    bulk.cut();
    state.dir = "/srv";
    list.render([{ name: "f.txt", kind: "file", size: 9 }]);
    await bulk.paste();
    expect(sftpRename).not.toHaveBeenCalled();
    expect(els.status.textContent).toBe(t("sftp.bulk.partial"));
    expect(hooks.notifyError).toHaveBeenCalledWith(expect.objectContaining({ message: t("sftp.move.exists") }));
  });

  it("delete removes every selected entry after one confirmation", async () => {
    const { els, list, browser, hooks, bulk } = setup();
    list.toggleAll();
    await bulk.delete();
    expect(sftpRemove).toHaveBeenCalledWith("a", "/home/sub", true, true);
    expect(sftpRemove).toHaveBeenCalledWith("a", "/home/f.txt", false, false);
    expect(browser.loadDir).toHaveBeenCalledWith("/home");
    expect(els.status.textContent).toBe(t("sftp.deleted.other", { count: 2 }));
    expect(hooks.notifySuccess).toHaveBeenCalled();
  });

  it("delete removes nothing when declined, or once disconnected", async () => {
    const { session, list, bulk } = setup();
    list.toggleAll();
    h.confirmed = false;
    await bulk.delete();
    h.confirmed = true;
    const { confirm } = await import("../../ui/confirm");
    vi.mocked(confirm).mockImplementationOnce(async () => {
      session.markDisconnected();
      return true;
    });
    await bulk.delete();
    expect(sftpRemove).not.toHaveBeenCalled();
  });

  it("a failed delete is reported, with no success toast", async () => {
    vi.mocked(sftpRemove).mockRejectedValue({ code: "Sftp", message: "denied" });
    const { list, hooks, bulk } = setup();
    list.toggleCheck(1, false);
    await bulk.delete();
    expect(hooks.notifySuccess).not.toHaveBeenCalled();
    expect(hooks.notifyError).toHaveBeenCalledWith({ code: "Sftp", message: "denied" });
    vi.mocked(sftpRemove).mockReset();
  });
});
