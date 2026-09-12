/**
 * @vitest-environment happy-dom
 *
 * The About dialog: opens with a placeholder, fills in the live version from
 * `ping()` (falling back to a plain message on failure), and dismisses via the
 * Close button, the overlay, and Escape — restoring focus to the trigger.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatPingMessage } from "../version";

const { pingMock } = vi.hoisted(() => ({ pingMock: vi.fn() }));
vi.mock("../ipc", () => ({ ping: (...args: unknown[]) => pingMock(...args) }));

import { openAboutDialog } from "./aboutDialog";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".about-dialog");
}

beforeEach(() => {
  document.body.innerHTML = "";
  pingMock.mockReset();
  pingMock.mockResolvedValue("1.4.0");
});

describe("openAboutDialog", () => {
  it("appends the dialog with the tagline and a version placeholder", () => {
    openAboutDialog();
    const root = dialog();
    expect(root).not.toBeNull();
    expect(root?.querySelector(".about-tagline")?.textContent).toContain(
      "SSH",
    );
    expect(root?.querySelector(".about-version")?.textContent).toBe(
      "Checking version…",
    );
  });

  it("fills in the version once ping resolves", async () => {
    openAboutDialog();
    await flush();
    expect(dialog()?.querySelector(".about-version")?.textContent).toBe(
      formatPingMessage("1.4.0"),
    );
  });

  it("shows a fallback when ping rejects", async () => {
    pingMock.mockRejectedValue(new Error("backend down"));
    openAboutDialog();
    await flush();
    expect(dialog()?.querySelector(".about-version")?.textContent).toBe(
      "Version unavailable",
    );
  });

  it("closes on the Close button", () => {
    openAboutDialog();
    dialog()?.querySelector<HTMLButtonElement>('[data-action="close"]')?.click();
    expect(dialog()).toBeNull();
  });

  it("closes on an overlay click", () => {
    openAboutDialog();
    dialog()?.querySelector<HTMLElement>(".dialog-overlay")?.click();
    expect(dialog()).toBeNull();
  });

  it("closes on Escape and restores focus to the trigger", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();

    openAboutDialog();
    expect(dialog()).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
