import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SftpEntry } from "../../ipc";

const h = vi.hoisted(() => ({
  answer: "new" as string | null,
  confirmed: true,
  mode: null as number | null,
}));

vi.mock("../../ipc", () => ({
  sftpMkdir: vi.fn(async () => {}),
  sftpRename: vi.fn(async () => {}),
  sftpRemove: vi.fn(async () => {}),
  sftpChmod: vi.fn(async () => {}),
}));
vi.mock("../../ui/confirm", () => ({
  prompt: vi.fn(async () => h.answer),
  confirm: vi.fn(async () => h.confirmed),
  choosePermissions: vi.fn(async () => h.mode),
}));

import { sftpChmod, sftpMkdir, sftpRemove, sftpRename } from "../../ipc";
import { choosePermissions, confirm, prompt } from "../../ui/confirm";
import { t } from "../../i18n";
import { EntryOperations, removeEntry } from "./entryOperations";
import { PanelFeedback } from "./panelFeedback";
import { PanelSession } from "./panelSession";
import type { DirectoryBrowser } from "./directoryBrowser";
import type { EditSessions } from "../editSessions";

const file: SftpEntry = { name: "f.txt", kind: "file", size: 1, mode: 0o644 };
const dir: SftpEntry = { name: "sub", kind: "dir", size: 0 };

function setup() {
  const session = new PanelSession();
  session.markConnected("a");
  const state = { dir: "/home" };
  const browser = {
    place: () => (session.activeDeviceId ? { deviceId: session.activeDeviceId, dir: state.dir } : null),
    isAt: (place: { deviceId: string; dir: string }) =>
      session.activeDeviceId === place.deviceId && state.dir === place.dir,
    reload: vi.fn(async () => true),
  };
  const edits = { open: vi.fn(async () => {}) };
  const hooks = { notifyError: vi.fn(), notifySuccess: vi.fn(), resync: vi.fn() };
  const clearHover = vi.fn();
  const operations = new EntryOperations({
    browser: browser as unknown as DirectoryBrowser,
    feedback: new PanelFeedback(hooks),
    edits: edits as unknown as EditSessions,
    clearHover,
  });
  return { session, state, browser, edits, hooks, clearHover, operations };
}

describe("EntryOperations", () => {
  beforeEach(() => {
    h.answer = "new";
    h.confirmed = true;
    h.mode = null;
    vi.clearAllMocks();
  });

  it("mkdir creates the trimmed name in the current directory and re-lists it", async () => {
    h.answer = "  logs ";
    const { browser, operations } = setup();
    await operations.mkdir();
    expect(sftpMkdir).toHaveBeenCalledWith("a", "/home/logs");
    expect(browser.reload).toHaveBeenCalled();
  });

  it("mkdir does nothing for a cancelled or blank name", async () => {
    const { operations } = setup();
    for (const answer of [null, "   "]) {
      h.answer = answer;
      await operations.mkdir();
    }
    expect(sftpMkdir).not.toHaveBeenCalled();
  });

  it("rename moves the entry to the new name", async () => {
    h.answer = " g.txt ";
    const { clearHover, operations } = setup();
    await operations.rename(file);
    expect(clearHover).toHaveBeenCalled();
    expect(sftpRename).toHaveBeenCalledWith("a", "/home/f.txt", "/home/g.txt");
  });

  it("rename does nothing for a cancelled, blank or unchanged name", async () => {
    const { operations } = setup();
    for (const answer of [null, " ", "f.txt"]) {
      h.answer = answer;
      await operations.rename(file);
    }
    expect(sftpRename).not.toHaveBeenCalled();
  });

  it("delete asks first, then removes (a folder recursively)", async () => {
    const { operations } = setup();
    await operations.delete(dir);
    expect(confirm).toHaveBeenCalledWith(t("sftp.delete.messageDir", { name: "sub" }), expect.objectContaining({ danger: true }));
    expect(sftpRemove).toHaveBeenCalledWith("a", "/home/sub", true, true);

    h.confirmed = false;
    await operations.delete(file);
    expect(confirm).toHaveBeenLastCalledWith(t("sftp.delete.message", { name: "f.txt" }), expect.anything());
    expect(sftpRemove).toHaveBeenCalledOnce();
  });

  it("permissions applies the chosen mode and says so", async () => {
    h.mode = 0o755;
    const { hooks, operations } = setup();
    await operations.permissions(file);
    expect(choosePermissions).toHaveBeenCalledWith("f.txt", 0o644);
    expect(sftpChmod).toHaveBeenCalledWith("a", "/home/f.txt", 0o755);
    expect(hooks.notifySuccess).toHaveBeenCalledWith(t("sftp.perms.changed", { name: "f.txt" }));
  });

  it("permissions starts from 0 for an unknown mode, and a cancel changes nothing", async () => {
    const { operations } = setup();
    await operations.permissions(dir);
    expect(choosePermissions).toHaveBeenCalledWith("sub", 0);
    expect(sftpChmod).not.toHaveBeenCalled();
  });

  it("reports a failed operation", async () => {
    vi.mocked(sftpMkdir).mockRejectedValueOnce({ code: "Sftp", message: "exists" });
    const { hooks, browser, operations } = setup();
    await operations.mkdir();
    expect(hooks.notifyError).toHaveBeenCalledWith({ code: "Sftp", message: "exists" });
    expect(browser.reload).not.toHaveBeenCalled();
  });

  it("edit opens the file in place", async () => {
    const { edits, clearHover, operations } = setup();
    await operations.edit(file);
    expect(clearHover).toHaveBeenCalled();
    expect(edits.open).toHaveBeenCalledWith("a", "/home/f.txt", "f.txt");
  });

  it("does nothing while disconnected", async () => {
    const { session, edits, operations } = setup();
    session.markDisconnected();
    await operations.mkdir();
    await operations.rename(file);
    await operations.delete(file);
    await operations.permissions(file);
    await operations.edit(file);
    expect(confirm).not.toHaveBeenCalled();
    expect(choosePermissions).not.toHaveBeenCalled();
    expect(edits.open).not.toHaveBeenCalled();
  });

  it("does nothing when the connection closed while a dialog was open", async () => {
    const { session, operations } = setup();
    vi.mocked(confirm).mockImplementationOnce(async () => {
      session.markDisconnected();
      return true;
    });
    await operations.delete(file);
    expect(sftpRemove).not.toHaveBeenCalled();
  });
});

describe("EntryOperations after a dialog outlived its place", () => {
  beforeEach(() => {
    h.answer = "new";
    h.confirmed = true;
    h.mode = 0o700;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.mocked(prompt).mockImplementation(async () => h.answer);
    vi.mocked(confirm).mockImplementation(async () => h.confirmed);
    vi.mocked(choosePermissions).mockImplementation(async () => h.mode);
  });

  type Setup = ReturnType<typeof setup>;
  const actions: [string, (ops: Setup["operations"]) => Promise<void>][] = [
    ["mkdir", (ops) => ops.mkdir()],
    ["rename", (ops) => ops.rename(file)],
    ["delete", (ops) => ops.delete(file)],
    ["permissions", (ops) => ops.permissions(file)],
  ];

  /** Make every dialog run `change` before it answers. */
  function changeDuringDialogs(change: () => void): void {
    vi.mocked(prompt).mockImplementation(async () => (change(), h.answer));
    vi.mocked(confirm).mockImplementation(async () => (change(), h.confirmed));
    vi.mocked(choosePermissions).mockImplementation(async () => (change(), h.mode));
  }

  for (const [name, run] of actions) {
    it(`${name} does nothing on another device connected meanwhile`, async () => {
      const ctx = setup();
      changeDuringDialogs(() => (ctx.session.markConnected("b")));
      await run(ctx.operations);
      expect([sftpMkdir, sftpRename, sftpRemove, sftpChmod].some((fn) => vi.mocked(fn).mock.calls.length)).toBe(false);
      expect(ctx.browser.reload).not.toHaveBeenCalled();
    });

    it(`${name} does nothing once another directory is listed`, async () => {
      const ctx = setup();
      changeDuringDialogs(() => (ctx.state.dir = "/srv"));
      await run(ctx.operations);
      expect([sftpMkdir, sftpRename, sftpRemove, sftpChmod].some((fn) => vi.mocked(fn).mock.calls.length)).toBe(false);
    });
  }

});

describe("removeEntry", () => {
  it("removes a file plainly", async () => {
    await removeEntry("a", "/home", file);
    expect(sftpRemove).toHaveBeenCalledWith("a", "/home/f.txt", false, false);
  });
});
