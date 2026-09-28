/**
 * @vitest-environment happy-dom
 *
 * Unit tests for `SettingsController` (F6 — previously no colocated test).
 * `../ipc` is mocked; terminal appearance is applied through an injected
 * `applyTerminalSettings` callback (in the app, `main.ts` fans it across every
 * tab's grid), so the tests pass a plain spy.
 *
 * Covers: settings load + fallback on failure, the `persistLastProfileId`
 * skip-if-unchanged optimization, and the live-apply → save →
 * adopt-backend-clamped-value round trip.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Settings, TerminalSettings } from "../ipc";

vi.mock("../ipc", () => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
}));

import { SettingsController } from "./settingsController";
import { getSettings, saveSettings } from "../ipc";
import { setLocale } from "../i18n";

function fakeGrid(): {
  applyTerminalSettings: ReturnType<typeof vi.fn<(s: TerminalSettings) => void>>;
} {
  return { applyTerminalSettings: vi.fn<(s: TerminalSettings) => void>() };
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    version: 1,
    terminal: { fontSize: 14, fontFamily: "Consolas", theme: "dark", scrollback: 1000 },
    lastProfileId: null,
    language: null,
    keepalive: { intervalSecs: 30, countMax: 3 },
    sftp: { idleDisconnectMins: 10 },
    updates: { checkOnLaunch: false },
    tray: { closeToTray: false },
    ...overrides,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = '<button id="theme-btn"></button><button id="settings-btn"></button>';
  vi.mocked(getSettings).mockReset();
  vi.mocked(saveSettings).mockReset();
});

describe("SettingsController.init", () => {
  it("loads persisted settings and exposes them via terminalSettings()", async () => {
    const g = fakeGrid();
    vi.mocked(getSettings).mockResolvedValue(
      settings({
        terminal: { fontSize: 20, fontFamily: "Fira Code", theme: "light", scrollback: 5000 },
      }),
    );

    const controller = new SettingsController({ applyTerminalSettings: g.applyTerminalSettings, onError: vi.fn() });
    await controller.init();

    expect(controller.terminalSettings()).toEqual({
      fontSize: 20,
      fontFamily: "Fira Code",
      theme: "light",
      scrollback: 5000,
    });
  });

  it("falls back to defaults and reports the error when getSettings rejects", async () => {
    const g = fakeGrid();
    const onError = vi.fn();
    vi.mocked(getSettings).mockRejectedValue({ code: "Io", message: "disk error" });

    const controller = new SettingsController({ applyTerminalSettings: g.applyTerminalSettings, onError });
    await controller.init();

    expect(onError).toHaveBeenCalledWith("disk error");
    expect(controller.terminalSettings()).toEqual({
      fontSize: 14,
      fontFamily: '"Cascadia Mono", Consolas, monospace',
      theme: "dark",
      scrollback: 1000,
    });
    expect(controller.lastProfileId()).toBeNull();
  });

  it("wires the settings button to open the dialog", async () => {
    const g = fakeGrid();
    vi.mocked(getSettings).mockResolvedValue(settings());

    const controller = new SettingsController({ applyTerminalSettings: g.applyTerminalSettings, onError: vi.fn() });
    await controller.init();

    expect(document.querySelector(".settings-dialog")).toBeNull();
    document.querySelector<HTMLButtonElement>("#settings-btn")?.click();
    expect(document.querySelector(".settings-dialog")).not.toBeNull();
  });

  it("names the dialog by its title and links the update checkbox to its hint", async () => {
    vi.mocked(getSettings).mockResolvedValue(settings());
    const controller = new SettingsController({ applyTerminalSettings: vi.fn(), onError: vi.fn() });
    await controller.init();
    document.querySelector<HTMLButtonElement>("#settings-btn")?.click();

    const dialog = document.querySelector(".settings-dialog");
    const titleId = dialog?.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(titleId)?.textContent).toBe("Settings");
    const box = document.querySelector(".settings-check-updates");
    const hintId = box?.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(hintId)?.textContent).toContain("update server");
  });

  it("puts the fields in a scroll body between the fixed header and footer", async () => {
    vi.mocked(getSettings).mockResolvedValue(settings());
    const controller = new SettingsController({ applyTerminalSettings: vi.fn(), onError: vi.fn() });
    await controller.init();
    document.querySelector<HTMLButtonElement>("#settings-btn")?.click();

    const body = document.querySelector(".settings-content > .settings-body");
    expect(body).not.toBeNull();
    expect(body?.querySelector(".settings-font-size")).toBeInstanceOf(HTMLElement);
    expect(body?.querySelector(".settings-check-updates")).toBeInstanceOf(HTMLElement);
    expect(document.querySelector(".settings-content > .dialog-header")).not.toBeNull();
    expect(document.querySelector(".settings-content > .form-actions")).not.toBeNull();
  });
});

describe("SettingsController.persistLastProfileId", () => {
  it("skips the save when the id is unchanged", async () => {
    const g = fakeGrid();
    vi.mocked(getSettings).mockResolvedValue(settings({ lastProfileId: null }));

    const controller = new SettingsController({ applyTerminalSettings: g.applyTerminalSettings, onError: vi.fn() });
    await controller.init();

    await controller.persistLastProfileId(null);

    expect(saveSettings).not.toHaveBeenCalled();
    expect(controller.lastProfileId()).toBeNull();
  });

  it("saves when the id changes, then skips a repeat of the new id", async () => {
    const g = fakeGrid();
    vi.mocked(getSettings).mockResolvedValue(settings({ lastProfileId: null }));
    vi.mocked(saveSettings).mockImplementation(async (s: Settings) => s);

    const controller = new SettingsController({ applyTerminalSettings: g.applyTerminalSettings, onError: vi.fn() });
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

    const controller = new SettingsController({ applyTerminalSettings: g.applyTerminalSettings, onError: vi.fn() });
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
      settings({
        terminal: { fontSize: 14, fontFamily: "Consolas", theme: "dark", scrollback: 1000 },
      }),
    );
    // Backend clamps an out-of-range font size to its max (40).
    vi.mocked(saveSettings).mockImplementation(async (s: Settings) => ({
      ...s,
      terminal: { ...s.terminal, fontSize: 40 },
    }));

    const controller = new SettingsController({ applyTerminalSettings: g.applyTerminalSettings, onError: vi.fn() });
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
      settings({
        terminal: { fontSize: 16, fontFamily: "Consolas", theme: "dark", scrollback: 1000 },
      }),
    );
    vi.mocked(saveSettings).mockImplementation(async (s: Settings) => s);

    const controller = new SettingsController({ applyTerminalSettings: g.applyTerminalSettings, onError: vi.fn() });
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

describe("SettingsController update check on launch", () => {
  it("exposes the stored opt-in", async () => {
    vi.mocked(getSettings).mockResolvedValue(settings({ updates: { checkOnLaunch: true } }));
    const controller = new SettingsController({ applyTerminalSettings: vi.fn(), onError: vi.fn() });
    await controller.init();
    expect(controller.checkUpdatesOnLaunch()).toBe(true);
  });

  it("is off when settings fail to load", async () => {
    vi.mocked(getSettings).mockRejectedValue({ code: "Io", message: "disk error" });
    const controller = new SettingsController({ applyTerminalSettings: vi.fn(), onError: vi.fn() });
    await controller.init();
    expect(controller.checkUpdatesOnLaunch()).toBe(false);
  });

  it("reflects the setting in the dialog checkbox and persists a toggle", async () => {
    vi.mocked(getSettings).mockResolvedValue(settings());
    vi.mocked(saveSettings).mockImplementation(async (s: Settings) => s);
    const controller = new SettingsController({ applyTerminalSettings: vi.fn(), onError: vi.fn() });
    await controller.init();
    document.querySelector<HTMLButtonElement>("#settings-btn")?.click();

    const box = document.querySelector<HTMLInputElement>(".settings-check-updates");
    expect(box?.checked).toBe(false);
    if (!box) throw new Error("unreachable");
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await flush();

    expect(vi.mocked(saveSettings).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ updates: { checkOnLaunch: true } }),
    );
    expect(controller.checkUpdatesOnLaunch()).toBe(true);
  });
});

describe("SettingsController close to tray", () => {
  it("reflects the setting in the dialog checkbox and persists a toggle", async () => {
    vi.mocked(getSettings).mockResolvedValue(settings());
    vi.mocked(saveSettings).mockImplementation(async (s: Settings) => s);
    const controller = new SettingsController({ applyTerminalSettings: vi.fn(), onError: vi.fn() });
    await controller.init();
    document.querySelector<HTMLButtonElement>("#settings-btn")?.click();

    const box = document.querySelector<HTMLInputElement>(".settings-close-to-tray");
    expect(box?.checked).toBe(false);
    if (!box) throw new Error("unreachable");
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await flush();

    expect(vi.mocked(saveSettings).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ tray: { closeToTray: true } }),
    );
  });

  it("unticks the box and reports an error when the tray is unavailable", async () => {
    vi.mocked(getSettings).mockResolvedValue(settings());
    // The backend stores close-to-tray as off when it can't build the icon.
    vi.mocked(saveSettings).mockImplementation(async (s: Settings) => ({
      ...s,
      tray: { closeToTray: false },
    }));
    const onError = vi.fn();
    const controller = new SettingsController({ applyTerminalSettings: vi.fn(), onError });
    await controller.init();
    document.querySelector<HTMLButtonElement>("#settings-btn")?.click();

    const box = document.querySelector<HTMLInputElement>(".settings-close-to-tray");
    if (!box) throw new Error("unreachable");
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await flush();

    expect(box.checked).toBe(false);
    expect(onError).toHaveBeenCalledWith("The system tray isn't available on this desktop.");
  });

  it("checks the box when the setting is stored on", async () => {
    vi.mocked(getSettings).mockResolvedValue(settings({ tray: { closeToTray: true } }));
    const controller = new SettingsController({ applyTerminalSettings: vi.fn(), onError: vi.fn() });
    await controller.init();
    document.querySelector<HTMLButtonElement>("#settings-btn")?.click();

    expect(document.querySelector<HTMLInputElement>(".settings-close-to-tray")?.checked).toBe(true);
  });
});

describe("SettingsController theme toggle", () => {
  async function initWith(theme: "dark" | "light") {
    const g = fakeGrid();
    vi.mocked(getSettings).mockResolvedValue(
      settings({ terminal: { fontSize: 14, fontFamily: "Consolas", theme, scrollback: 1000 } }),
    );
    vi.mocked(saveSettings).mockImplementation(async (s: Settings) => s);
    const controller = new SettingsController({ applyTerminalSettings: g.applyTerminalSettings, onError: vi.fn() });
    await controller.init();
    const button = document.querySelector<HTMLButtonElement>("#theme-btn");
    if (!button) throw new Error("unreachable");
    return { g, controller, button };
  }

  it("renders the button for the loaded theme", async () => {
    const { button } = await initWith("dark");
    expect(button.getAttribute("aria-label")).toBe("Switch to light theme");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("switches dark to light live, persists it, and flips the button", async () => {
    const { g, controller, button } = await initWith("dark");

    button.click();
    await flush();

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(g.applyTerminalSettings).toHaveBeenCalledWith(expect.objectContaining({ theme: "light" }));
    expect(vi.mocked(saveSettings).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ terminal: expect.objectContaining({ theme: "light", fontSize: 14 }) }),
    );
    expect(controller.terminalSettings().theme).toBe("light");
    expect(button.getAttribute("aria-label")).toBe("Switch to dark theme");
  });

  it("switches light back to dark", async () => {
    const { button } = await initWith("light");
    button.click();
    await flush();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(button.getAttribute("aria-label")).toBe("Switch to light theme");
  });

  it("follows a theme another instance saved", async () => {
    const { button, controller } = await initWith("dark");
    vi.mocked(getSettings).mockResolvedValue(
      settings({ terminal: { fontSize: 14, fontFamily: "Consolas", theme: "light", scrollback: 1000 } }),
    );
    await controller.reloadFromDisk();
    expect(button.getAttribute("aria-label")).toBe("Switch to dark theme");
  });

  it("is no longer part of the Settings dialog", async () => {
    await initWith("dark");
    document.querySelector<HTMLButtonElement>("#settings-btn")?.click();
    expect(document.querySelector(".settings-dialog")).not.toBeNull();
    expect(document.querySelector(".settings-theme")).toBeNull();
  });
});

describe("SettingsController dialog tabs", () => {
  async function openDialog() {
    vi.mocked(getSettings).mockResolvedValue(settings());
    const controller = new SettingsController({ applyTerminalSettings: vi.fn(), onError: vi.fn() });
    await controller.init();
    document.querySelector<HTMLButtonElement>("#settings-btn")?.click();
  }

  /** The field classes a panel holds, in document order. */
  function fieldsIn(panel: string): string[] {
    const root = document.querySelector(`.settings-dialog [data-panel="${panel}"]`);
    return [...(root?.querySelectorAll<HTMLElement>("input, select") ?? [])].map((el) => el.className);
  }

  it("opens on General: language, font, font size, scrollback, update check, then close to tray", async () => {
    await openDialog();
    expect(fieldsIn("general")).toEqual([
      "settings-language",
      "settings-font-family",
      "settings-font-size",
      "settings-scrollback",
      "settings-check-updates",
      "settings-close-to-tray",
    ]);
    expect(document.querySelector<HTMLElement>('[data-panel="general"]')?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('[data-panel="connections"]')?.hidden).toBe(true);
  });

  it("puts the connection settings in the Connections tab", async () => {
    await openDialog();
    expect(fieldsIn("connections")).toEqual([
      "settings-keepalive-interval",
      "settings-keepalive-count",
      "settings-sftp-idle",
    ]);

    document.querySelector<HTMLButtonElement>('[data-tab="connections"]')?.click();

    expect(document.querySelector<HTMLElement>('[data-panel="connections"]')?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('[data-panel="general"]')?.hidden).toBe(true);
  });
});

describe("SettingsController live language switch", () => {
  const text = (selector: string): string | undefined =>
    document.querySelector(`.settings-dialog ${selector}`)?.textContent?.trim();

  async function openAndPick(language: string) {
    vi.mocked(getSettings).mockResolvedValue(settings({ language: "en" }));
    vi.mocked(saveSettings).mockImplementation(async (s: Settings) => s);
    const controller = new SettingsController({ applyTerminalSettings: vi.fn(), onError: vi.fn() });
    await controller.init();
    document.querySelector<HTMLButtonElement>("#settings-btn")?.click();
    const select = document.querySelector<HTMLSelectElement>(".settings-language");
    if (!select) throw new Error("unreachable");
    select.value = language;
    select.dispatchEvent(new Event("change"));
    await flush();
    return select;
  }

  it("re-translates the open dialog as soon as a language is picked", async () => {
    try {
      const select = await openAndPick("fr");

      expect(text("h2")).toBe("Paramètres");
      expect(text('[data-tab="general"]')).toBe("Général");
      expect(text('[data-tab="connections"]')).toBe("Connexions");
      expect(text(".form-field span")).toBe("Langue");
      expect(text(".form-hint")).toBe("Lignes d'historique conservées par terminal (0–100000).");
      expect(text(".form-group-checkbox label")).toBe("Rechercher les mises à jour au démarrage");
      expect(text('[data-action="close"]')).toBe("Fermer");
      expect(text('.settings-language option[value=""]')).toBe("Langue du système");
      // The controls themselves survive: same element, choice kept, checkbox intact.
      expect(select.isConnected).toBe(true);
      expect(select.value).toBe("fr");
      expect(document.querySelector(".settings-check-updates")).not.toBeNull();
    } finally {
      setLocale("en");
    }
  });

  it("stops listening once the dialog is closed", async () => {
    try {
      await openAndPick("fr");
      document.querySelector<HTMLButtonElement>('.settings-dialog [data-action="close"]')?.click();
      expect(() => setLocale("de")).not.toThrow();
      expect(document.querySelector(".settings-dialog")).toBeNull();
    } finally {
      setLocale("en");
    }
  });
});
