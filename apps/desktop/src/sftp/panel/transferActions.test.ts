import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SftpEntry } from "../../ipc";

const h = vi.hoisted(() => ({
  savePath: "C:/dl/f.txt" as string | null,
  dirPath: "C:/dl" as string | null,
  openPath: "C:/up/f.txt" as string | null,
  uploadDir: "C:/up/proj" as string | null,
  localExists: false,
  remoteExists: false,
  choice: "overwrite" as "overwrite" | "skip" | "rename" | null,
}));

vi.mock("../../ipc", () => ({
  sftpDownload: vi.fn(async () => 1),
  sftpDownloadDir: vi.fn(async (): Promise<string[]> => []),
  sftpUpload: vi.fn(async () => 1),
  sftpUploadDir: vi.fn(async (): Promise<string[]> => []),
  sftpExists: vi.fn(async () => h.remoteExists),
  sftpLocalExists: vi.fn(async () => h.localExists),
}));
vi.mock("../../ui/fileDialog", () => ({
  pickDownloadSavePath: vi.fn(async () => h.savePath),
  pickDownloadDirPath: vi.fn(async () => h.dirPath),
  pickUploadOpenPath: vi.fn(async () => h.openPath),
  pickUploadDirPath: vi.fn(async () => h.uploadDir),
}));
vi.mock("../../ui/confirm", () => ({ chooseConflict: vi.fn(async () => h.choice) }));
vi.mock("@tauri-apps/api/path", () => ({
  basename: vi.fn(async (p: string) => p.split("/").pop() ?? p),
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
}));

import { sftpDownload, sftpDownloadDir, sftpUpload, sftpUploadDir } from "../../ipc";
import {
  pickDownloadDirPath,
  pickDownloadSavePath,
  pickUploadDirPath,
  pickUploadOpenPath,
} from "../../ui/fileDialog";
import { chooseConflict } from "../../ui/confirm";
import { t } from "../../i18n";
import type { EnqueueSpec } from "../transferQueue";
import { PanelFeedback } from "./panelFeedback";
import { PanelSession } from "./panelSession";
import { TransferActions } from "./transferActions";

const file: SftpEntry = { name: "f.txt", kind: "file", size: 1 };
const folder: SftpEntry = { name: "sub", kind: "dir", size: 0 };
const unsafe: SftpEntry = { name: "..\\x.bat", kind: "file", size: 1 };

function setup() {
  const session = new PanelSession();
  session.markConnected("a");
  const queued: EnqueueSpec[] = [];
  const state = { dir: "/home" };
  const hooks = { notifyError: vi.fn(), notifySuccess: vi.fn(), resync: vi.fn() };
  const clearHover = vi.fn();
  const transfers = new TransferActions({
    feedback: new PanelFeedback(hooks),
    enqueue: (spec) => queued.push(spec),
    place: () => (session.activeDeviceId ? { deviceId: session.activeDeviceId, dir: state.dir } : null),
    isAt: (place) => session.activeDeviceId === place.deviceId && state.dir === place.dir,
    clearHover,
  });
  return { session, state, queued, hooks, clearHover, transfers };
}

describe("TransferActions", () => {
  beforeEach(() => {
    Object.assign(h, {
      savePath: "C:/dl/f.txt",
      dirPath: "C:/dl",
      openPath: "C:/up/f.txt",
      uploadDir: "C:/up/proj",
      localExists: false,
      remoteExists: false,
      choice: "overwrite",
    });
    vi.clearAllMocks();
  });

  it("download queues the file to the picked path, with a toast", async () => {
    const { queued, clearHover, transfers } = setup();
    await transfers.download(file);
    expect(clearHover).toHaveBeenCalled();
    expect(queued[0]).toMatchObject({ deviceId: "a", direction: "download", isDir: false, name: "f.txt" });
    expect(queued[0]?.successToast).toBe(t("sftp.downloadedToast", { name: "f.txt" }));
    await queued[0]?.run();
    expect(sftpDownload).toHaveBeenCalledWith("a", "/home/f.txt", "C:/dl/f.txt");
  });

  it("download queues nothing when cancelled, disconnected, or for an unsafe name", async () => {
    const { session, queued, hooks, transfers } = setup();
    h.savePath = null;
    await transfers.download(file);
    await transfers.download(unsafe);
    expect(hooks.notifyError).toHaveBeenCalledWith(expect.objectContaining({ code: "Validation" }));
    session.markDisconnected();
    await transfers.download(file);
    expect(queued).toEqual([]);
    expect(pickDownloadSavePath).toHaveBeenCalledOnce();
  });

  it("downloadFolder queues a recursive download under the chosen policy", async () => {
    h.localExists = true;
    h.choice = "skip";
    const { queued, transfers } = setup();
    await transfers.downloadFolder(folder);
    expect(queued[0]).toMatchObject({ direction: "download", isDir: true, name: "sub" });
    await queued[0]?.run();
    expect(sftpDownloadDir).toHaveBeenCalledWith("a", "/home/sub", "C:/dl/sub", "skip");
  });

  it("downloadFolder queues nothing when the dialogs are cancelled", async () => {
    const { queued, transfers } = setup();
    h.dirPath = null;
    await transfers.downloadFolder(folder);
    h.dirPath = "C:/dl";
    h.localExists = true;
    h.choice = null;
    await transfers.downloadFolder(folder);
    expect(queued).toEqual([]);
  });

  it("reports what a folder transfer skipped", async () => {
    vi.mocked(sftpDownloadDir).mockResolvedValueOnce(["/home/sub/a", "/home/sub/b"]);
    const { queued, hooks, transfers } = setup();
    await transfers.downloadFolder(folder);
    await queued[0]?.run();
    expect(hooks.notifyError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "Sftp", message: expect.stringContaining("a, b") }),
    );
  });

  it("upload queues the file into the current directory and re-lists it", async () => {
    const { queued, transfers } = setup();
    await transfers.upload();
    expect(queued[0]).toMatchObject({ direction: "upload", isDir: false, name: "f.txt", refreshDir: "/home" });
    await queued[0]?.run();
    expect(sftpUpload).toHaveBeenCalledWith("a", "C:/up/f.txt", "/home/f.txt");
  });

  it("an upload skipped at its conflict ends as a quiet cancel", async () => {
    h.remoteExists = true;
    h.choice = "skip";
    const { queued, transfers } = setup();
    await transfers.upload();
    await expect(queued[0]?.run()).rejects.toMatchObject({ code: "Cancelled" });
    expect(sftpUpload).not.toHaveBeenCalled();
  });

  it("uploadFolder queues a recursive upload and reports skipped entries", async () => {
    vi.mocked(sftpUploadDir).mockResolvedValueOnce(["bad"]);
    const { queued, hooks, transfers } = setup();
    await transfers.uploadFolder();
    expect(queued[0]).toMatchObject({ direction: "upload", isDir: true, name: "proj", refreshDir: "/home" });
    await queued[0]?.run();
    expect(sftpUploadDir).toHaveBeenCalledWith("a", "C:/up/proj", "/home/proj", "overwrite");
    expect(hooks.notifyError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("bad") }));
  });

  it("uploads queue nothing when cancelled or disconnected", async () => {
    const { session, queued, transfers } = setup();
    h.openPath = null;
    h.uploadDir = null;
    await transfers.upload();
    await transfers.uploadFolder();
    h.uploadDir = "C:/up/proj";
    h.remoteExists = true;
    h.choice = null;
    await transfers.uploadFolder();
    session.markDisconnected();
    await transfers.upload();
    expect(queued).toEqual([]);
  });

  it("queueBulkItem fetches a file to its own destination, a folder recursively", async () => {
    h.localExists = true;
    const { queued, transfers } = setup();
    transfers.queueBulkItem("a", "/home/f.txt", file, "C:/dl/f.txt", "skip");
    transfers.queueBulkItem("a", "/home/sub", folder, "C:/dl/sub", "overwrite");
    expect(queued.map((spec) => spec.isDir)).toEqual([false, true]);
    expect(queued[0]?.successToast).toBeUndefined();
    await queued[0]?.run();
    expect(sftpDownload).not.toHaveBeenCalled(); // skipped: it exists
    await queued[1]?.run();
    expect(sftpDownloadDir).toHaveBeenCalledWith("a", "/home/sub", "C:/dl/sub", "overwrite");

    h.localExists = false;
    await queued[0]?.run();
    expect(sftpDownload).toHaveBeenCalledWith("a", "/home/f.txt", "C:/dl/f.txt");
  });

  it("refuseUnsafeNames lets safe names through", () => {
    const { hooks, transfers } = setup();
    expect(transfers.refuseUnsafeNames([file, folder])).toBe(false);
    expect(transfers.refuseUnsafeNames([file, unsafe])).toBe(true);
    expect(hooks.notifyError).toHaveBeenCalledWith(
      expect.objectContaining({ message: t("sftp.download.unsafeName", { name: unsafe.name }) }),
    );
  });
});

describe("TransferActions after a dialog outlived its place", () => {
  beforeEach(() => {
    Object.assign(h, {
      savePath: "C:/dl/f.txt",
      dirPath: "C:/dl",
      openPath: "C:/up/f.txt",
      uploadDir: "C:/up/proj",
      localExists: true,
      remoteExists: true,
      choice: "overwrite",
    });
    vi.clearAllMocks();
  });

  type Setup = ReturnType<typeof setup>;
  const switchDevice = (ctx: Setup) => (ctx.session.markConnected("b"));
  const switchDir = (ctx: Setup) => (ctx.state.dir = "/srv");

  it("download queues nothing on another device connected during the save dialog", async () => {
    const ctx = setup();
    vi.mocked(pickDownloadSavePath).mockImplementationOnce(async () => (switchDevice(ctx), h.savePath));
    await ctx.transfers.download(file);
    expect(ctx.queued).toEqual([]);
  });

  it("downloadFolder queues nothing once another directory is listed", async () => {
    const ctx = setup();
    vi.mocked(pickDownloadDirPath).mockImplementationOnce(async () => (switchDir(ctx), h.dirPath));
    await ctx.transfers.downloadFolder(folder);
    expect(ctx.queued).toEqual([]);
  });

  it("downloadFolder queues nothing on another device connected during the conflict dialog", async () => {
    const ctx = setup();
    vi.mocked(chooseConflict).mockImplementationOnce(async () => (switchDevice(ctx), "overwrite"));
    await ctx.transfers.downloadFolder(folder);
    expect(ctx.queued).toEqual([]);
  });

  it("upload queues nothing on another device connected during the open dialog", async () => {
    const ctx = setup();
    vi.mocked(pickUploadOpenPath).mockImplementationOnce(async () => (switchDevice(ctx), h.openPath));
    await ctx.transfers.upload();
    expect(ctx.queued).toEqual([]);
  });

  it("uploadFolder queues nothing once another directory is listed", async () => {
    const ctx = setup();
    vi.mocked(pickUploadDirPath).mockImplementationOnce(async () => (switchDir(ctx), h.uploadDir));
    await ctx.transfers.uploadFolder();
    expect(ctx.queued).toEqual([]);
  });

  it("uploadFolder queues nothing on another device connected during the conflict dialog", async () => {
    const ctx = setup();
    vi.mocked(chooseConflict).mockImplementationOnce(async () => (switchDevice(ctx), "overwrite"));
    await ctx.transfers.uploadFolder();
    expect(ctx.queued).toEqual([]);
  });
});
