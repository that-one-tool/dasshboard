/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, saveMock, openMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  saveMock: vi.fn(),
  openMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => saveMock(...args),
  open: (...args: unknown[]) => openMock(...args),
}));
vi.mock("@tauri-apps/api/path", () => ({
  homeDir: async () => "/home/me",
  join: async (...parts: string[]) => parts.join("/"),
}));

import { FILE_ACTIONS, runFileAction, type FileAction } from "./deviceFileActions";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function action(selector: string): FileAction {
  const found = FILE_ACTIONS.find((a) => a.selector === selector);
  if (!found) throw new Error(selector);
  return found;
}

function context() {
  return { feedback: { error: vi.fn(), success: vi.fn() }, reload: vi.fn(async () => {}) };
}

beforeEach(() => {
  document.body.innerHTML = "";
  invokeMock.mockReset();
  saveMock.mockReset().mockResolvedValue("/out/file");
  openMock.mockReset().mockResolvedValue("/in/file");
});

describe("FILE_ACTIONS", () => {
  it("has one action per toolbar button", () => {
    expect(FILE_ACTIONS.map((a) => a.selector)).toEqual([
      ".device-export-btn",
      ".device-import-btn",
      ".device-import-ssh-btn",
      ".device-export-ssh-btn",
    ]);
  });
});

describe("runFileAction", () => {
  it("exports JSON and reports the count without reloading", async () => {
    invokeMock.mockResolvedValue(3);
    const ctx = context();
    await runFileAction(action(".device-export-btn"), ctx);
    expect(invokeMock).toHaveBeenCalledWith("export_devices", { path: "/out/file" });
    expect(ctx.feedback.success).toHaveBeenCalledWith("Exported 3 devices");
    expect(ctx.reload).not.toHaveBeenCalled();
  });

  it("does nothing when the picker is cancelled", async () => {
    saveMock.mockResolvedValue(null);
    const ctx = context();
    await runFileAction(action(".device-export-btn"), ctx);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(ctx.feedback.success).not.toHaveBeenCalled();
  });

  it("imports JSON without asking when nothing is risky, then reports and reloads", async () => {
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "preview_devices_import" ? [] : 1));
    const ctx = context();
    await runFileAction(action(".device-import-btn"), ctx);
    expect(invokeMock).toHaveBeenCalledWith("import_devices", { path: "/in/file", confirmedRisks: [] });
    expect(ctx.feedback.success).toHaveBeenCalledWith("Imported 1 device");
    expect(ctx.reload).toHaveBeenCalledTimes(1);
  });

  it("imports nothing and reports nothing when the risks are declined", async () => {
    invokeMock.mockResolvedValue([{ name: "Box", risks: ["agentForwarding"] }]);
    const ctx = context();
    const done = runFileAction(action(".device-import-btn"), ctx);
    await flush();
    document.querySelector<HTMLElement>('.confirm-dialog [data-action="cancel"]')?.click();
    await done;
    expect(invokeMock.mock.calls.map((call) => call[0])).toEqual(["preview_devices_import"]);
    expect(ctx.feedback.success).not.toHaveBeenCalled();
    expect(ctx.reload).not.toHaveBeenCalled();
  });

  it("imports an SSH config, naming the skipped hosts, then reloads", async () => {
    invokeMock.mockResolvedValue({ imported: 2, skipped: 1 });
    const ctx = context();
    await runFileAction(action(".device-import-ssh-btn"), ctx);
    expect(invokeMock).toHaveBeenCalledWith("import_ssh_config", { path: "/in/file" });
    expect(ctx.feedback.success).toHaveBeenCalledWith("Imported 2 devices from SSH config (1 skipped)");
    expect(ctx.reload).toHaveBeenCalled();
  });

  it("exports an SSH config with or without skipped devices", async () => {
    const ctx = context();
    invokeMock.mockResolvedValue({ exported: 1, skipped: 0 });
    await runFileAction(action(".device-export-ssh-btn"), ctx);
    invokeMock.mockResolvedValue({ exported: 2, skipped: 3 });
    await runFileAction(action(".device-export-ssh-btn"), ctx);
    expect(ctx.feedback.success.mock.calls).toEqual([
      ["Exported 1 device to SSH config"],
      ["Exported 2 devices to SSH config (3 non-SSH skipped)"],
    ]);
    expect(ctx.reload).not.toHaveBeenCalled();
  });

  it("reports a failure as an error", async () => {
    const failure = { code: "Io", message: "disk full" };
    invokeMock.mockRejectedValue(failure);
    const ctx = context();
    await runFileAction(action(".device-export-btn"), ctx);
    expect(ctx.feedback.error).toHaveBeenCalledWith(failure);
    expect(ctx.feedback.success).not.toHaveBeenCalled();
  });
});
