/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, afterEach } from "vitest";
import { choosePermissions } from "./permissionsDialog";

afterEach(() => {
  // Answer every dialog a test left open, so none stays in the dialog stack.
  document.querySelectorAll(".dialog-overlay").forEach((overlay) => {
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  document.body.innerHTML = "";
});

function boxes(): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>('.perms-body input[type="checkbox"]')];
}

function box(index: number): HTMLInputElement {
  const found = boxes()[index];
  if (!found) throw new Error(`no checkbox ${index}`);
  return found;
}

function octal(): string | undefined {
  return document.querySelector(".perms-octal")?.textContent ?? undefined;
}

function click(selector: string): void {
  document.querySelector(selector)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("choosePermissions", () => {
  it("shows the name and an owner/group/other grid prefilled from the mode", () => {
    void choosePermissions("file.txt", 0o754);
    expect(document.querySelector(".perms-name")?.textContent).toBe("file.txt");
    expect(document.querySelectorAll(".perms-body tr")).toHaveLength(3);
    expect(boxes().map((box) => box.checked)).toEqual([
      true, true, true,
      true, false, true,
      true, false, false,
    ]);
    expect(box(1).getAttribute("aria-label")).toMatch(/ w$/);
    expect(octal()).toBe("754");
  });

  it("updates the octal readout as boxes change", () => {
    void choosePermissions("f", 0o600);
    const groupRead = box(3);
    groupRead.checked = true;
    groupRead.dispatchEvent(new Event("change", { bubbles: true }));
    expect(octal()).toBe("640");
  });

  it("resolves the edited bits merged with the original special bits on OK", async () => {
    const result = choosePermissions("f", 0o4755);
    expect(octal()).toBe("4755");
    box(8).checked = false;
    click('[data-action="ok"]');
    await expect(result).resolves.toBe(0o4754);
  });

  it("resolves null on cancel, the overlay and Escape", async () => {
    const cancelled = choosePermissions("f", 0o644);
    click('[data-action="cancel"]');
    await expect(cancelled).resolves.toBeNull();
    const overlay = choosePermissions("f", 0o644);
    click(".dialog-overlay");
    await expect(overlay).resolves.toBeNull();
    const escaped = choosePermissions("f", 0o644);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect(escaped).resolves.toBeNull();
  });

  it("focuses OK on open", () => {
    void choosePermissions("f", 0o644);
    expect((document.activeElement as HTMLElement).dataset.action).toBe("ok");
  });
});
