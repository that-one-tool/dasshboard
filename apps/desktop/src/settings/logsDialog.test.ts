/**
 * @vitest-environment happy-dom
 *
 * The Logs dialog (header button): loads the lines on open, closes on Close,
 * Escape or the overlay, and gives focus back to the button that opened it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../ipc", () => ({
  getLogs: vi.fn(async () => [{ timeMs: 0, level: "warn", message: "tunnel h:22: connection lost" }]),
  clearLogs: vi.fn(),
}));

import { openLogsDialog } from "./logsDialog";
import { getLogs } from "../ipc";
import { pushDialog, removeDialog } from "../ui/dialogStack";
import { applyDomTranslations, setLocale } from "../i18n";

const onError = vi.fn<(message: string) => void>();
const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>(".logs-dialog");
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  document.body.innerHTML = `<button id="logs-btn">Logs</button>`;
  document.querySelector<HTMLButtonElement>("#logs-btn")?.focus();
  vi.mocked(getLogs).mockClear();
  onError.mockReset();
});

afterEach(() => {
  dialog()?.querySelector<HTMLElement>(".dialog-overlay")?.click();
});

describe("openLogsDialog", () => {
  it("is a modal named by its title", () => {
    void openLogsDialog({ onError });
    const root = dialog();
    expect(root?.getAttribute("aria-modal")).toBe("true");
    const titleId = root?.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(titleId)?.textContent).toBe("Connection logs");
  });

  it("loads the log lines on open", async () => {
    void openLogsDialog({ onError });
    await flush();
    expect(getLogs).toHaveBeenCalledOnce();
    expect(document.querySelector(".logs-message")?.textContent).toBe("tunnel h:22: connection lost");
  });

  it("focuses Close, and closes on it, giving focus back", async () => {
    const closed = openLogsDialog({ onError });
    const close = dialog()?.querySelector<HTMLButtonElement>('[data-action="cancel"]');
    expect(document.activeElement).toBe(close);
    close?.click();
    await closed;
    expect(dialog()).toBeNull();
    expect(document.activeElement?.id).toBe("logs-btn");
  });

  it("closes on Escape", async () => {
    const closed = openLogsDialog({ onError });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await closed;
    expect(dialog()).toBeNull();
  });

  it("closes on an overlay click", async () => {
    const closed = openLogsDialog({ onError });
    dialog()?.querySelector<HTMLElement>(".dialog-overlay")?.click();
    await closed;
    expect(dialog()).toBeNull();
  });

  it("leaves Escape to a dialog opened over it", () => {
    void openLogsDialog({ onError });
    const over = document.createElement("div");
    pushDialog(over);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(dialog()).not.toBeNull();
    removeDialog(over);
  });

  it("the panel's buttons do not close it", async () => {
    void openLogsDialog({ onError });
    dialog()?.querySelector<HTMLButtonElement>(".logs-refresh")?.click();
    await flush();
    expect(dialog()).not.toBeNull();
  });

  it("re-translates its title and Close on a language change", () => {
    void openLogsDialog({ onError });
    setLocale("fr");
    applyDomTranslations(document);
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Journaux de connexion");
    expect(dialog()?.querySelector('[data-action="cancel"]')?.textContent).toBe("Fermer");
    setLocale("en");
  });

  it("does not open a second one while open", () => {
    void openLogsDialog({ onError });
    void openLogsDialog({ onError });
    expect(document.querySelectorAll(".logs-dialog")).toHaveLength(1);
    expect(getLogs).toHaveBeenCalledOnce();
  });

  it("reports a load failure", async () => {
    vi.mocked(getLogs).mockRejectedValueOnce({ code: "Io", message: "ipc down" });
    void openLogsDialog({ onError });
    await flush();
    expect(onError).toHaveBeenCalledWith("ipc down");
  });
});
