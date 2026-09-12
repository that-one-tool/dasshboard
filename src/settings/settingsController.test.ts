/**
 * @vitest-environment happy-dom
 *
 * Unit tests for `SettingsController` (F6 — previously no colocated test).
 * `../ipc` is mocked; the `Grid` collaborator is a minimal fake exposing only
 * `applyTerminalSettings`, mirroring the fake-Grid pattern already used in
 * `profileManager.test.ts`.
 *
 * Covers: settings load + fallback on failure, the `persistLastProfileId`
 * skip-if-unchanged optimization, and the live-apply → save →
 * adopt-backend-clamped-value round trip.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Grid } from "../grid";
import type { Settings } from "../ipc";

vi.mock("../ipc", () => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
}));

import { SettingsController } from "./settingsController";
import { getSettings, saveSettings } from "../ipc";

function fakeGrid(): { grid: Grid; applyTerminalSettings: ReturnType<typeof vi.fn> } {
  const applyTerminalSettings = vi.fn();
  return { grid: { applyTerminalSettings } as unknown as Grid, applyTerminalSettings };
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    version: 1,
    terminal: { fontSize: 14, fontFamily: "Consolas", theme: "dark" },
    lastProfileId: null,
    language: null,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = '<button id="settings-btn"></button>';
  vi.mocked(getSettings).mockReset();
  vi.mocked(saveSettings).mockReset();
});

describe("SettingsController.init", () => {
  it("loads persisted settings and exposes them via terminalSettings()", async () => {
    const g = fakeGrid();
    vi.mocked(getSettings).mockResolvedValue(
      settings({ terminal: { fontSize: 20, fontFamily: "Fira Code", theme: "light" } }),
    );

    const controller = new SettingsController({ grid: g.grid, onError: vi.fn() });
    await controller.init();

    expect(controller.terminalSettings()).toEqual({
      fontSize: 20,
      fontFamily: "Fira Code",
      theme: "light",
    });
  });

  it("falls back to defaults and reports the error when getSettings rejects", async () => {
    const g = fakeGrid();
    const onError = vi.fn();
    vi.mocked(getSettings).mockRejectedValue({ code: "Io", message: "disk error" });

    const controller = new SettingsController({ grid: g.grid, onError });
    await controller.init();

    expect(onError).toHaveBeenCalledWith("disk error");
    expect(controller.terminalSettings()).toEqual({
      fontSize: 14,
      fontFamily: '"Cascadia Mono", Consolas, monospace',
      theme: "dark",
    });
    expect(controller.lastProfileId()).toBeNull();
  });

  it("wires the settings button to open the dialog", async () => {
    const g = fakeGrid();
    vi.mocked(getSettings).mockResolvedValue(settings());

    const controller = new SettingsController({ grid: g.grid, onError: vi.fn() });
    await controller.init();

    expect(document.querySelector(".settings-dialog")).toBeNull();
    document.querySelector<HTMLButtonElement>("#settings-btn")?.click();
    expect(document.querySelector(".settings-dialog")).not.toBeNull();
  });
});

describe("SettingsController.persistLastProfileId", () => {
  it("skips the save when the id is unchanged", async () => {
    const g = fakeGrid();
    vi.mocked(getSettings).mockResolvedValue(settings({ lastProfileId: null }));

    const controller = new SettingsController({ grid: g.grid, onError: vi.fn() });
    await controller.init();

    await controller.persistLastProfileId(null);

    expect(saveSettings).not.toHaveBeenCalled();
    expect(controller.lastProfileId()).toBeNull();
  });

  it("saves when the id changes, then skips a repeat of the new id", async () => {
    const g = fakeGrid();
    vi.mocked(getSettings).mockResolvedValue(settings({ lastProfileId: null }));
    vi.mocked(saveSettings).mockImplementation(async (s: Settings) => s);

    const controller = new SettingsController({ grid: g.grid, onError: vi.fn() });
    await controller.init();

    await controller.persistLastProfileId("profile-1");
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveSettings).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ lastProfileId: "profile-1" }),
    );
    expect(controller.lastProfileId()).toBe("profile-1");

    // Same id again: the optimization must skip a redundant write.
    await controller.persistLastProfileId("profile-1");
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it("saves again when the id changes a second time", async () => {
    const g = fakeGrid();
    vi.mocked(getSettings).mockResolvedValue(settings({ lastProfileId: null }));
    vi.mocked(saveSettings).mockImplementation(async (s: Settings) => s);

    const controller = new SettingsController({ grid: g.grid, onError: vi.fn() });
    await controller.init();

    await controller.persistLastProfileId("profile-1");
    await controller.persistLastProfileId("profile-2");

    expect(saveSettings).toHaveBeenCalledTimes(2);
    expect(controller.lastProfileId()).toBe("profile-2");
  });
});

describe("SettingsController live-apply round trip", () => {
  it("applies live, saves, and adopts the backend-clamped value back into the field", async () => {
    const g = fakeGrid();
    vi.mocked(getSettings).mockResolvedValue(
      settings({ terminal: { fontSize: 14, fontFamily: "Consolas", theme: "dark" } }),
    );
    // Backend clamps an out-of-range font size to its max (40).
    vi.mocked(saveSettings).mockImplementation(async (s: Settings) => ({
      ...s,
      terminal: { ...s.terminal, fontSize: 40 },
    }));

    const controller = new SettingsController({ grid: g.grid, onError: vi.fn() });
    await controller.init();
    document.querySelector<HTMLButtonElement>("#settings-btn")?.click();

    const fontSizeInput = document.querySelector<HTMLInputElement>(".settings-font-size");
    expect(fontSizeInput).not.toBeNull();
    if (!fontSizeInput) throw new Error("unreachable");

    fontSizeInput.value = "999"; // out of range; the backend will clamp it
    fontSizeInput.dispatchEvent(new Event("change"));
    await flush();

    // Live-applied to the grid immediately with the raw parsed value...
    expect(g.applyTerminalSettings).toHaveBeenCalledWith(
      expect.objectContaining({ fontSize: 999 }),
    );
    // ...then persisted...
    expect(saveSettings).toHaveBeenCalledTimes(1);
    // ...and the clamped value the backend actually stored is reflected back
    // into both the input and `terminalSettings()`.
    expect(fontSizeInput.value).toBe("40");
    expect(controller.terminalSettings().fontSize).toBe(40);
  });

  it("keeps the current font size when the field is non-numeric", async () => {
    const g = fakeGrid();
    vi.mocked(getSettings).mockResolvedValue(
      settings({ terminal: { fontSize: 16, fontFamily: "Consolas", theme: "dark" } }),
    );
    vi.mocked(saveSettings).mockImplementation(async (s: Settings) => s);

    const controller = new SettingsController({ grid: g.grid, onError: vi.fn() });
    await controller.init();
    document.querySelector<HTMLButtonElement>("#settings-btn")?.click();

    const fontSizeInput = document.querySelector<HTMLInputElement>(".settings-font-size");
    if (!fontSizeInput) throw new Error("unreachable");

    fontSizeInput.value = "not-a-number";
    fontSizeInput.dispatchEvent(new Event("change"));
    await flush();

    expect(g.applyTerminalSettings).toHaveBeenCalledWith(
      expect.objectContaining({ fontSize: 16 }),
    );
  });
});
