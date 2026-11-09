import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  remote: new Set<string>(),
  local: new Set<string>(),
  choice: "overwrite" as "overwrite" | "skip" | "rename" | null,
}));

vi.mock("../../ipc", () => ({
  sftpExists: vi.fn(async (_id: string, path: string) => h.remote.has(path)),
  sftpLocalExists: vi.fn(async (path: string) => h.local.has(path)),
}));
vi.mock("../../ui/confirm", () => ({ chooseConflict: vi.fn(async () => h.choice) }));
vi.mock("@tauri-apps/api/path", () => ({ join: vi.fn(async (...parts: string[]) => parts.join("/")) }));

import { chooseConflict } from "../../ui/confirm";
import { t } from "../../i18n";
import {
  bulkConflictMessage,
  bulkFileDestination,
  freshLocalName,
  freshRemoteName,
  resolveLocalTargets,
  resolvePolicy,
  uploadTarget,
} from "./transferConflicts";
import type { SftpEntry } from "../../ipc";

const file = (name: string): SftpEntry => ({ name, kind: "file", size: 1 });

describe("transfer conflicts", () => {
  beforeEach(() => {
    h.remote = new Set();
    h.local = new Set();
    h.choice = "overwrite";
    vi.clearAllMocks();
  });

  it("resolvePolicy overwrites without asking when nothing clashes", async () => {
    expect(await resolvePolicy(false, "m")).toBe("overwrite");
    expect(chooseConflict).not.toHaveBeenCalled();
  });

  it("resolvePolicy asks on a clash", async () => {
    h.choice = "skip";
    expect(await resolvePolicy(true, "m")).toBe("skip");
    expect(chooseConflict).toHaveBeenCalledWith("m");
  });

  it("bulkConflictMessage names a single entry, and not several", () => {
    expect(bulkConflictMessage([file("a")])).toBe(t("sftp.conflict.message", { name: "a" }));
    expect(bulkConflictMessage([file("a"), file("b")])).toBe(t("sftp.conflict.messageMany"));
  });

  it("uploadTarget keeps a free remote path", async () => {
    expect(await uploadTarget("d", "/r/a", "a")).toBe("/r/a");
  });

  it("uploadTarget follows the conflict choice", async () => {
    h.remote.add("/r/a");
    h.choice = "overwrite";
    expect(await uploadTarget("d", "/r/a", "a")).toBe("/r/a");
    h.choice = "skip";
    expect(await uploadTarget("d", "/r/a", "a")).toBeNull();
    h.choice = null;
    expect(await uploadTarget("d", "/r/a", "a")).toBeNull();
    h.choice = "rename";
    expect(await uploadTarget("d", "/r/a", "a")).toBe("/r/a (2)");
  });

  it("freshRemoteName gives up when every name is taken", async () => {
    const { sftpExists } = await import("../../ipc");
    vi.mocked(sftpExists).mockImplementation(async () => true);
    await expect(freshRemoteName("d", "/r/a", "a")).rejects.toMatchObject({
      message: t("sftp.upload.noFreeName", { name: "a" }),
    });
    vi.mocked(sftpExists).mockImplementation(async (_id: string, path: string) => h.remote.has(path));
  });

  it("freshLocalName keeps a free path, else finds the next free one", async () => {
    expect(await freshLocalName("C:/a", "a")).toBe("C:/a");
    h.local.add("C:/a");
    expect(await freshLocalName("C:/a", "a")).toBe("C:/a (2)");
  });

  it("freshLocalName gives up when every name is taken", async () => {
    const { sftpLocalExists } = await import("../../ipc");
    vi.mocked(sftpLocalExists).mockImplementation(async () => true);
    await expect(freshLocalName("C:/a", "a")).rejects.toMatchObject({
      message: t("sftp.download.noFreeName", { name: "a" }),
    });
    vi.mocked(sftpLocalExists).mockImplementation(async (path: string) => h.local.has(path));
  });

  it("bulkFileDestination skips an existing file only under skip", async () => {
    h.local.add("C:/a");
    expect(await bulkFileDestination("C:/a", "a", "skip")).toBeNull();
    expect(await bulkFileDestination("C:/b", "b", "skip")).toBe("C:/b");
    expect(await bulkFileDestination("C:/a", "a", "overwrite")).toBe("C:/a");
    expect(await bulkFileDestination("C:/a", "a", "rename")).toBe("C:/a (2)");
  });

  it("resolveLocalTargets joins each name and flags any clash", async () => {
    const entries = [file("a"), file("b")];
    expect(await resolveLocalTargets(entries, "C:")).toEqual({
      targets: [
        { entry: entries[0], target: "C:/a" },
        { entry: entries[1], target: "C:/b" },
      ],
      conflict: false,
    });
    h.local.add("C:/b");
    expect((await resolveLocalTargets(entries, "C:")).conflict).toBe(true);
  });
});
