/**
 * @vitest-environment happy-dom
 *
 * Phase 6: the shared modal helpers unify the confirm/prompt dialogs that had
 * been copy-pasted across grid/profile/device code. These guard the keyboard
 * affordances that unification added uniformly — Enter accepts, Escape cancels —
 * plus the click paths, so a future edit can't silently drop them.
 */

import { describe, it, expect, afterEach } from "vitest";
import { confirm, prompt } from "./confirm";

afterEach(() => {
  document.body.innerHTML = "";
});

function press(key: string): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

function click(selector: string): void {
  document
    .querySelector<HTMLElement>(selector)
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("confirm", () => {
  it("resolves true when the confirm button is clicked", async () => {
    const p = confirm("go?");
    click('.confirm-dialog [data-action="confirm"]');
    expect(await p).toBe(true);
    expect(document.querySelector(".confirm-dialog")).toBeNull();
  });

  it("resolves false on cancel and on overlay click", async () => {
    const p1 = confirm("go?");
    click('.confirm-dialog [data-action="cancel"]');
    expect(await p1).toBe(false);

    const p2 = confirm("go?");
    click(".confirm-dialog .dialog-overlay");
    expect(await p2).toBe(false);
  });

  it("Enter accepts and Escape cancels", async () => {
    const p1 = confirm("go?");
    press("Enter");
    expect(await p1).toBe(true);

    const p2 = confirm("go?");
    press("Escape");
    expect(await p2).toBe(false);
  });

  it("renders the message and options via textContent", async () => {
    const p = confirm("Delete \"A & B\"?", {
      title: "Delete device?",
      confirmLabel: "Delete",
      danger: true,
    });
    const dialog = document.querySelector(".confirm-dialog");
    expect(dialog?.querySelector(".confirm-message")?.textContent).toBe(
      'Delete "A & B"?',
    );
    expect(dialog?.querySelector(".confirm-title")?.textContent).toBe(
      "Delete device?",
    );
    const confirmBtn = dialog?.querySelector('[data-action="confirm"]');
    expect(confirmBtn?.textContent?.trim()).toBe("Delete");
    expect(confirmBtn?.classList.contains("btn-danger")).toBe(true);
    click('.confirm-dialog [data-action="cancel"]');
    await p;
  });
});

describe("prompt", () => {
  it("resolves the entered value on OK", async () => {
    const p = prompt("Name?", "placeholder", "seed");
    const input = document.querySelector<HTMLInputElement>(".prompt-input");
    expect(input?.value).toBe("seed");
    if (input) input.value = "typed";
    click('.prompt-dialog [data-action="ok"]');
    expect(await p).toBe("typed");
  });

  it("resolves null on cancel and Escape", async () => {
    const p1 = prompt("Name?", "");
    click('.prompt-dialog [data-action="cancel"]');
    expect(await p1).toBeNull();

    const p2 = prompt("Name?", "");
    document
      .querySelector(".prompt-dialog")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(await p2).toBeNull();
  });

  it("Enter resolves the current input value", async () => {
    const p = prompt("Name?", "");
    const input = document.querySelector<HTMLInputElement>(".prompt-input");
    if (input) input.value = "entered";
    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(await p).toBe("entered");
  });
});
