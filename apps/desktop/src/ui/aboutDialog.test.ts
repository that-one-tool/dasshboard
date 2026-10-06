/**
 * @vitest-environment happy-dom
 *
 * The About dialog: opens with a placeholder, fills in the live version from
 * `ping()` (falling back to a plain message on failure), and dismisses via the
 * Close button, the overlay, and Escape — restoring focus to the trigger.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatPingMessage } from "../version";
import type { UpdateController } from "../updates/updateController";

const { pingMock } = vi.hoisted(() => ({ pingMock: vi.fn() }));
vi.mock("../ipc", () => ({ ping: (...args: unknown[]) => pingMock(...args) }));

import { openAboutDialog } from "./aboutDialog";
import { pushDialog, removeDialog } from "./dialogStack";

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

  it("is laid out like the other dialogs: header, body, footer", () => {
    openAboutDialog();
    const content = dialog()!.querySelector(".dialog-content")!;
    const parts = Array.from(content.children).map((el) => el.className);
    expect(parts).toEqual(["dialog-header", "about-body", "form-actions"]);
    expect(content.querySelector(".dialog-header h2")?.textContent).toBe("About DaSSHboard");
    expect(content.querySelector(".about-body .about-version")).not.toBeNull();
    expect(content.querySelector('.form-actions [data-action="close"]')).not.toBeNull();
  });

  it("puts the update section in the body", () => {
    openAboutDialog({
      available: () => null,
      isInstalling: () => false,
      installFailed: () => false,
      isUpToDate: () => false,
      subscribe: () => () => {},
    } as unknown as UpdateController);
    expect(dialog()?.querySelector(".about-body .about-update")).not.toBeNull();
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

  it("mounts the update section when given a controller and unmounts it on close", () => {
    const unsubscribe = vi.fn();
    const updates = {
      available: vi.fn(() => null),
      isInstalling: vi.fn(() => false),
      installFailed: vi.fn(() => false),
      isUpToDate: vi.fn(() => false),
      subscribe: vi.fn(() => unsubscribe),
      check: vi.fn(),
      install: vi.fn(),
    } as unknown as UpdateController;
    openAboutDialog(updates);
    expect(dialog()?.querySelector('[data-update="check"]')).toBeInstanceOf(HTMLElement);

    dialog()?.querySelector<HTMLButtonElement>('[data-action="close"]')?.click();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("has no update section without a controller", () => {
    openAboutDialog();
    expect(dialog()?.querySelector('[data-update="check"]')).toBeNull();
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

  it("leaves Escape to a dialog opened over it (e.g. the update confirm)", () => {
    openAboutDialog();
    const over = document.createElement("div");
    pushDialog(over);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(dialog()).not.toBeNull();
    removeDialog(over);
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
