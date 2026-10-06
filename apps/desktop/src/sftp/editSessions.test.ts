import { describe, it, expect, vi, beforeEach } from "vitest";

const ipc = vi.hoisted(() => ({
  sftpEditOpen: vi.fn(),
  sftpEditLaunch: vi.fn(),
  sftpEditCheck: vi.fn(),
  sftpEditUpload: vi.fn(),
  sftpEditDiscard: vi.fn(),
  sftpEditClose: vi.fn(),
  sftpEditableSize: vi.fn(),
}));
vi.mock("../ipc", () => ipc);

import { EditSessions, LARGE_EDIT_BYTES, type EditSessionsHooks } from "./editSessions";
import type { SftpEditInfo } from "../ipc";

const INFO: SftpEditInfo = {
  editId: "e1",
  deviceId: "d1",
  remotePath: "/etc/app.conf",
  name: "app.conf",
};

function makeHooks(overrides: Partial<EditSessionsHooks> = {}): EditSessionsHooks {
  return {
    runTransfer: vi.fn((spec) => spec.run()),
    confirm: vi.fn(async () => true),
    chooseConflict: vi.fn(async () => null),
    onChange: vi.fn(),
    onError: vi.fn(),
    onSuccess: vi.fn(),
    ...overrides,
  };
}

async function openedWith(hooks: EditSessionsHooks): Promise<EditSessions> {
  const edits = new EditSessions(hooks);
  ipc.sftpEditOpen.mockResolvedValueOnce(INFO);
  await edits.open("d1", "/etc/app.conf", "app.conf");
  return edits;
}

beforeEach(() => {
  for (const fn of Object.values(ipc)) fn.mockReset();
  ipc.sftpEditableSize.mockResolvedValue(10);
});

describe("opening an edit", () => {
  it("downloads through the transfer queue and lists the edit as synced", async () => {
    const hooks = makeHooks();
    const edits = await openedWith(hooks);

    expect(hooks.runTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: "d1", direction: "download", name: "app.conf" }),
    );
    expect(ipc.sftpEditOpen).toHaveBeenCalledWith("d1", "/etc/app.conf");
    expect(edits.entries()).toEqual([{ info: INFO, status: "synced" }]);
    expect(hooks.onChange).toHaveBeenCalled();
  });

  it("asks before opening a large file, and declining does nothing", async () => {
    const hooks = makeHooks({ confirm: vi.fn(async () => false) });
    const edits = new EditSessions(hooks);
    ipc.sftpEditableSize.mockResolvedValueOnce(LARGE_EDIT_BYTES + 1);

    await edits.open("d1", "/var/log/big.log", "big.log");

    expect(ipc.sftpEditableSize).toHaveBeenCalledWith("d1", "/var/log/big.log");
    expect(hooks.confirm).toHaveBeenCalled();
    expect(ipc.sftpEditOpen).not.toHaveBeenCalled();
    expect(edits.entries()).toEqual([]);
  });

  it("does not ask for a file at the size limit", async () => {
    const hooks = makeHooks();
    const edits = new EditSessions(hooks);
    ipc.sftpEditableSize.mockResolvedValueOnce(LARGE_EDIT_BYTES);
    ipc.sftpEditOpen.mockResolvedValueOnce(INFO);

    await edits.open("d1", "/etc/app.conf", "app.conf");

    expect(hooks.confirm).not.toHaveBeenCalled();
    expect(edits.entries()).toHaveLength(1);
  });

  it("reopens the editor for a file already being edited instead of downloading it again", async () => {
    const hooks = makeHooks();
    const edits = await openedWith(hooks);

    await edits.open("d1", "/etc/app.conf", "app.conf");

    expect(ipc.sftpEditOpen).toHaveBeenCalledTimes(1);
    expect(ipc.sftpEditLaunch).toHaveBeenCalledWith("e1");
  });

  it("lists nothing when the download fails (the queue reports the error)", async () => {
    const hooks = makeHooks();
    const edits = new EditSessions(hooks);
    ipc.sftpEditOpen.mockRejectedValueOnce({ code: "Sftp", message: "denied" });

    await edits.open("d1", "/etc/shadow", "shadow");

    expect(edits.entries()).toEqual([]);
    expect(hooks.onError).not.toHaveBeenCalled();
  });

  it("reports a folder behind a link instead of opening it", async () => {
    const hooks = makeHooks();
    const edits = new EditSessions(hooks);
    const err = { code: "Validation", message: "/srv/www is a folder" };
    ipc.sftpEditableSize.mockRejectedValueOnce(err);

    await edits.open("d1", "/srv/www", "www");

    expect(hooks.onError).toHaveBeenCalledWith(err);
    expect(ipc.sftpEditOpen).not.toHaveBeenCalled();
  });

  it("opens a file once when Edit is clicked twice quickly", async () => {
    const edits = new EditSessions(makeHooks());
    ipc.sftpEditOpen.mockResolvedValue(INFO);

    await Promise.all([
      edits.open("d1", "/etc/app.conf", "app.conf"),
      edits.open("d1", "/etc/app.conf", "app.conf"),
    ]);

    expect(ipc.sftpEditOpen).toHaveBeenCalledTimes(1);
    expect(edits.entries()).toHaveLength(1);
  });

  it("drops an edit whose device closed while it was opening", async () => {
    let finishOpen!: (info: SftpEditInfo) => void;
    const hooks = makeHooks({
      runTransfer: vi.fn(() => new Promise((resolve) => (finishOpen = resolve))) as never,
    });
    const edits = new EditSessions(hooks);

    const opening = edits.open("d1", "/etc/app.conf", "app.conf");
    await vi.waitFor(() => expect(hooks.runTransfer).toHaveBeenCalled());
    edits.closeDevice("d1");
    finishOpen(INFO);
    await opening;

    expect(ipc.sftpEditClose).toHaveBeenCalledWith("e1");
    expect(edits.entries()).toEqual([]);
  });

  it("reports a failed relaunch", async () => {
    const hooks = makeHooks();
    const edits = await openedWith(hooks);
    ipc.sftpEditLaunch.mockRejectedValueOnce({ code: "Io", message: "no editor" });

    await edits.relaunch("e1");

    expect(hooks.onError).toHaveBeenCalledWith({ code: "Io", message: "no editor" });
  });
});

describe("syncing a saved edit", () => {
  it("uploads a clean change and confirms it", async () => {
    const hooks = makeHooks();
    const edits = await openedWith(hooks);
    ipc.sftpEditCheck.mockResolvedValueOnce("clean");
    ipc.sftpEditUpload.mockResolvedValueOnce("uploaded");

    await edits.handleChange("e1");

    expect(ipc.sftpEditUpload).toHaveBeenCalledWith("e1", false);
    expect(hooks.runTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ direction: "upload", name: "app.conf", cancellable: false }),
    );
    expect(hooks.onSuccess).toHaveBeenCalled();
    expect(edits.entries()[0]?.status).toBe("synced");
  });

  it("uploads nothing when the content did not change", async () => {
    const hooks = makeHooks();
    const edits = await openedWith(hooks);
    ipc.sftpEditCheck.mockResolvedValueOnce("unchanged");

    await edits.handleChange("e1");

    expect(ipc.sftpEditUpload).not.toHaveBeenCalled();
    expect(edits.entries()[0]?.status).toBe("synced");
  });

  it("overwrites the remote on a conflict when the user picks overwrite", async () => {
    const hooks = makeHooks({ chooseConflict: vi.fn(async () => "overwrite" as const) });
    const edits = await openedWith(hooks);
    ipc.sftpEditCheck.mockResolvedValueOnce("conflict");
    ipc.sftpEditUpload.mockResolvedValueOnce("uploaded");

    await edits.handleChange("e1");

    expect(hooks.chooseConflict).toHaveBeenCalledWith("app.conf");
    expect(ipc.sftpEditUpload).toHaveBeenCalledWith("e1", true);
    expect(edits.entries()[0]?.status).toBe("synced");
  });

  it("re-downloads the remote on a conflict when the user discards their changes", async () => {
    const hooks = makeHooks({ chooseConflict: vi.fn(async () => "discard" as const) });
    const edits = await openedWith(hooks);
    ipc.sftpEditCheck.mockResolvedValueOnce("conflict");

    await edits.handleChange("e1");

    expect(ipc.sftpEditDiscard).toHaveBeenCalledWith("e1");
    expect(ipc.sftpEditUpload).not.toHaveBeenCalled();
    expect(edits.entries()[0]?.status).toBe("synced");
  });

  it("keeps the changes pending when the conflict dialog is cancelled", async () => {
    const hooks = makeHooks();
    const edits = await openedWith(hooks);
    ipc.sftpEditCheck.mockResolvedValueOnce("conflict");

    await edits.handleChange("e1");

    expect(ipc.sftpEditUpload).not.toHaveBeenCalled();
    expect(edits.entries()[0]?.status).toBe("pending");
  });

  it("asks when the remote changed between the check and the upload", async () => {
    const hooks = makeHooks({ chooseConflict: vi.fn(async () => "overwrite" as const) });
    const edits = await openedWith(hooks);
    ipc.sftpEditCheck.mockResolvedValueOnce("clean");
    ipc.sftpEditUpload.mockResolvedValueOnce("conflict").mockResolvedValueOnce("uploaded");

    await edits.handleChange("e1");

    expect(ipc.sftpEditUpload).toHaveBeenNthCalledWith(2, "e1", true);
    expect(edits.entries()[0]?.status).toBe("synced");
  });

  it("keeps the changes pending when the upload fails", async () => {
    const hooks = makeHooks();
    const edits = await openedWith(hooks);
    ipc.sftpEditCheck.mockResolvedValueOnce("clean");
    ipc.sftpEditUpload.mockRejectedValueOnce({ code: "Sftp", message: "gone" });

    await edits.handleChange("e1");

    expect(edits.entries()[0]?.status).toBe("pending");
    expect(hooks.onError).not.toHaveBeenCalled();
  });

  it("reports a failed check and keeps the changes pending", async () => {
    const hooks = makeHooks();
    const edits = await openedWith(hooks);
    ipc.sftpEditCheck.mockRejectedValueOnce({ code: "Sftp", message: "no such file" });

    await edits.handleChange("e1");

    expect(hooks.onError).toHaveBeenCalledWith({ code: "Sftp", message: "no such file" });
    expect(edits.entries()[0]?.status).toBe("pending");
  });

  it("syncs again after a save that landed while syncing", async () => {
    const hooks = makeHooks();
    const edits = await openedWith(hooks);
    let releaseFirst!: () => void;
    ipc.sftpEditCheck
      .mockImplementationOnce(
        () => new Promise((resolve) => (releaseFirst = () => resolve("unchanged"))),
      )
      .mockResolvedValueOnce("unchanged");

    const first = edits.handleChange("e1");
    await edits.handleChange("e1");
    releaseFirst();
    await first;

    expect(ipc.sftpEditCheck).toHaveBeenCalledTimes(2);
  });

  it("ignores a change for an edit that is no longer open", async () => {
    const edits = new EditSessions(makeHooks());

    await edits.handleChange("gone");

    expect(ipc.sftpEditCheck).not.toHaveBeenCalled();
  });
});

describe("ending edits", () => {
  it("stops a synced edit without asking", async () => {
    const hooks = makeHooks();
    const edits = await openedWith(hooks);

    await edits.stop("e1");

    expect(hooks.confirm).not.toHaveBeenCalled();
    expect(ipc.sftpEditClose).toHaveBeenCalledWith("e1");
    expect(edits.entries()).toEqual([]);
  });

  it("asks before stopping an edit with changes not uploaded", async () => {
    const hooks = makeHooks();
    const edits = await openedWith(hooks);
    ipc.sftpEditCheck.mockResolvedValueOnce("conflict");
    await edits.handleChange("e1");
    vi.mocked(hooks.confirm).mockResolvedValueOnce(false);

    await edits.stop("e1");

    expect(ipc.sftpEditClose).not.toHaveBeenCalled();
    expect(edits.entries()).toHaveLength(1);
  });

  it("drops one device's edits when its connection closes", async () => {
    const hooks = makeHooks();
    const edits = await openedWith(hooks);
    ipc.sftpEditOpen.mockResolvedValueOnce({ ...INFO, editId: "e2", deviceId: "d2" });
    await edits.open("d2", "/etc/app.conf", "app.conf");

    edits.closeDevice("d1");

    expect(edits.entries().map((e) => e.info.editId)).toEqual(["e2"]);
    expect(edits.hasEdits("d1")).toBe(false);
    expect(edits.hasEdits("d2")).toBe(true);
  });

  it("counts a device's edits whose changes are not uploaded", async () => {
    const hooks = makeHooks();
    const edits = await openedWith(hooks);
    expect(edits.unsyncedCount("d1")).toBe(0);

    ipc.sftpEditCheck.mockResolvedValueOnce("conflict");
    await edits.handleChange("e1");

    expect(edits.unsyncedCount("d1")).toBe(1);
    expect(edits.unsyncedCount("d2")).toBe(0);
  });
});
