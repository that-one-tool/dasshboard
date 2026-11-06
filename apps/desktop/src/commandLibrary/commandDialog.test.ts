/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { openCommandDialog } from "./commandDialog";
import type { SavedCommand } from "../ipc";

const blank: SavedCommand = { id: "", name: "", text: "", run: true };

function field<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
}

function fill(name: string, text: string, run: boolean): void {
  field<HTMLInputElement>(".command-name-input").value = name;
  field<HTMLTextAreaElement>(".command-text-input").value = text;
  field<HTMLInputElement>(".command-run-input").checked = run;
}

function press(key: string, target: HTMLElement): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("openCommandDialog", () => {
  it("shows the command being edited and resolves the edited copy on Save", async () => {
    const result = openCommandDialog({ id: "c1", name: "Up", text: "uptime", run: false });
    expect(field<HTMLInputElement>(".command-name-input").value).toBe("Up");
    expect(field<HTMLInputElement>(".command-run-input").checked).toBe(false);
    expect(field(".command-dialog-title").textContent).toBe("Edit command");
    fill("Uptime", "uptime -p", true);
    field('[data-action="save"]').click();
    await expect(result).resolves.toEqual({ id: "c1", name: "Uptime", text: "uptime -p", run: true });
    expect(document.querySelector(".command-dialog")).toBeNull();
  });

  it("titles a new command as such", () => {
    void openCommandDialog(blank);
    expect(field(".command-dialog-title").textContent).toBe("New command");
  });

  it("stays open and says what is wrong with an invalid command", () => {
    void openCommandDialog(blank);
    fill("Two", "a\nb", false);
    field('[data-action="save"]').click();
    expect(field(".command-dialog-error").textContent).toBe("Without Enter, a command must fit on one line");
    expect(document.querySelector(".command-dialog")).not.toBeNull();
  });

  it("resolves null on Cancel, the overlay, or Escape", async () => {
    const cancelled = openCommandDialog(blank);
    field('button[data-action="cancel"]').click();
    await expect(cancelled).resolves.toBeNull();

    const dismissed = openCommandDialog(blank);
    field(".dialog-overlay").click();
    await expect(dismissed).resolves.toBeNull();

    const escaped = openCommandDialog(blank);
    press("Escape", field(".command-name-input"));
    await expect(escaped).resolves.toBeNull();
  });

  it("leaves Enter on a button to that button", () => {
    void openCommandDialog(blank);
    fill("Up", "uptime", true);
    const cancel = field('button[data-action="cancel"]');
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    cancel.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector(".command-dialog")).not.toBeNull();
  });

  it("saves on Enter in the name field, but Enter in the command adds a line", async () => {
    const result = openCommandDialog(blank);
    fill("Up", "uptime", true);
    press("Enter", field(".command-text-input"));
    expect(document.querySelector(".command-dialog")).not.toBeNull();
    press("Enter", field(".command-name-input"));
    await expect(result).resolves.toEqual({ id: "", name: "Up", text: "uptime", run: true });
  });
});
