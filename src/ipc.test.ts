/**
 * @vitest-environment happy-dom
 *
 * Unit tests for the import/export IPC wrappers (`exportDevices`,
 * `importDevices`, `exportProfiles`, `importProfiles`). Each must forward to the
 * correct backend command name with a `{ path }` payload and return the numeric
 * count the backend resolves. `@tauri-apps/api/core`'s `invoke` is mocked, as in
 * the other IPC-touching suites.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  exportDevices,
  importDevices,
  exportProfiles,
  importProfiles,
} from "./ipc";

beforeEach(() => {
  invokeMock.mockReset();
});

describe("import/export IPC wrappers", () => {
  const cases: Array<{
    name: string;
    fn: (path: string) => Promise<number>;
    command: string;
  }> = [
    { name: "exportDevices", fn: exportDevices, command: "export_devices" },
    { name: "importDevices", fn: importDevices, command: "import_devices" },
    { name: "exportProfiles", fn: exportProfiles, command: "export_profiles" },
    { name: "importProfiles", fn: importProfiles, command: "import_profiles" },
  ];

  for (const { name, fn, command } of cases) {
    it(`${name} calls ${command} with { path } and returns the count`, async () => {
      invokeMock.mockResolvedValue(3);
      const result = await fn("C:/tmp/file.json");
      expect(invokeMock).toHaveBeenCalledWith(command, {
        path: "C:/tmp/file.json",
      });
      expect(result).toBe(3);
    });
  }

  it("normalizes a rejected AppError from the backend", async () => {
    invokeMock.mockRejectedValue({ code: "Validation", message: "bad kind" });
    await expect(importDevices("C:/tmp/bad.json")).rejects.toEqual({
      code: "Validation",
      message: "bad kind",
    });
  });
});
