/**
 * @vitest-environment happy-dom
 *
 * Unit tests for the native file-picker wrappers. The Tauri dialog plugin's
 * `save`/`open` are mocked; these assert the JSON filter + default name are
 * passed through, that the chosen path is returned, and that a cancelled dialog
 * (the plugin resolves `null`) is surfaced as `null`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { saveMock, openMock } = vi.hoisted(() => ({
  saveMock: vi.fn(),
  openMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => saveMock(...args),
  open: (...args: unknown[]) => openMock(...args),
}));

import { pickJsonSavePath, pickJsonOpenPath } from "./fileDialog";

const JSON_FILTER = { name: "JSON", extensions: ["json"] };

beforeEach(() => {
  saveMock.mockReset();
  openMock.mockReset();
});

describe("pickJsonSavePath", () => {
  it("passes the default name + JSON filter and returns the chosen path", async () => {
    saveMock.mockResolvedValue("C:/out/devices.json");
    const path = await pickJsonSavePath("dasshboard-devices.json");
    expect(saveMock).toHaveBeenCalledWith({
      defaultPath: "dasshboard-devices.json",
      filters: [JSON_FILTER],
    });
    expect(path).toBe("C:/out/devices.json");
  });

  it("returns null when the save dialog is cancelled", async () => {
    saveMock.mockResolvedValue(null);
    expect(await pickJsonSavePath("x.json")).toBeNull();
  });
});

describe("pickJsonOpenPath", () => {
  it("opens a single-select JSON dialog and returns the chosen path", async () => {
    openMock.mockResolvedValue("C:/in/devices.json");
    const path = await pickJsonOpenPath();
    expect(openMock).toHaveBeenCalledWith({
      multiple: false,
      filters: [JSON_FILTER],
    });
    expect(path).toBe("C:/in/devices.json");
  });

  it("returns null when the open dialog is cancelled", async () => {
    openMock.mockResolvedValue(null);
    expect(await pickJsonOpenPath()).toBeNull();
  });
});
