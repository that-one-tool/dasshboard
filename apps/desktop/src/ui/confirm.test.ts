/**
 * @vitest-environment happy-dom
 *
 * Phase 6: the shared modal helpers unify the confirm/prompt dialogs that had
 * been copy-pasted across grid/profile/device code. These guard the keyboard
 * affordances that unification added uniformly — Enter accepts, Escape cancels —
 * plus the click paths, so a future edit can't silently drop them.
 */

import { describe, it, expect, afterEach } from "vitest";
import { confirm, prompt, chooseConflict, chooseEditConflict } from "./confirm";

afterEach(() => {
  // Answer every dialog a test left open, so none stays in the dialog stack
  // with a live document keydown listener.
  document.querySelectorAll(".dialog-overlay").forEach((overlay) => {
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
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

  it("keeps line breaks only when asked to", async () => {
    const plain = confirm("Delete a\nb?");
    const message = document.querySelector<HTMLElement>(".confirm-message");
    expect(message?.classList.contains("confirm-lines")).toBe(false);
    click('.confirm-dialog [data-action="cancel"]');
    await plain;

    const lines = confirm("a\nb", { keepLineBreaks: true });
    expect(document.querySelector(".confirm-message")?.classList.contains("confirm-lines")).toBe(true);
    click('.confirm-dialog [data-action="cancel"]');
    await lines;
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

  it("Enter on the focused Cancel button cancels instead of accepting", async () => {
    const p = confirm("delete everything?");
    document.querySelector<HTMLButtonElement>('.confirm-dialog [data-action="cancel"]')?.focus();
    press("Enter");
    expect(await p).toBe(false);
  });

  it("a key reaches only the newest of two stacked dialogs", async () => {
    let firstResult: boolean | null = null;
    const first = confirm("paste 3 lines?").then((r) => (firstResult = r));
    const second = confirm("trust this key?");

    press("Escape");
    expect(await second).toBe(false);
    await Promise.resolve();
    expect(firstResult).toBeNull(); // untouched by the key meant for the top one

    press("Enter");
    await first;
    expect(firstResult).toBe(true);
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

describe("chooseEditConflict", () => {
  it("names the file and resolves the chosen action", async () => {
    const p1 = chooseEditConflict("app.conf");
    expect(document.querySelector(".confirm-message")?.textContent).toContain("app.conf");
    click('.confirm-dialog [data-action="overwrite"]');
    expect(await p1).toBe("overwrite");

    const p2 = chooseEditConflict("app.conf");
    click('.confirm-dialog [data-action="discard"]');
    expect(await p2).toBe("discard");
    expect(document.querySelector(".confirm-dialog")).toBeNull();
  });

  it("resolves null for later, the overlay and Escape", async () => {
    const p1 = chooseEditConflict("app.conf");
    click('.confirm-dialog [data-action="cancel"]');
    expect(await p1).toBeNull();

    const p2 = chooseEditConflict("app.conf");
    click(".confirm-dialog .dialog-overlay");
    expect(await p2).toBeNull();

    const p3 = chooseEditConflict("app.conf");
    press("Escape");
    expect(await p3).toBeNull();
  });

  it("does not pick a destructive action on Enter", async () => {
    const p = chooseEditConflict("app.conf");
    press("Enter");
    click('.confirm-dialog [data-action="cancel"]');
    expect(await p).toBeNull();
  });
});

describe("chooseConflict", () => {
  it("shows the message as text and resolves each policy", async () => {
    for (const action of ["overwrite", "skip", "rename"] as const) {
      const p = chooseConflict("<b>exists</b>");
      expect(document.querySelector(".confirm-message")?.textContent).toBe("<b>exists</b>");
      click(`.confirm-dialog [data-action="${action}"]`);
      await expect(p).resolves.toBe(action);
    }
  });

  it("focuses Overwrite and resolves null on cancel, overlay and Escape", async () => {
    const cancelled = chooseConflict("x");
    expect((document.activeElement as HTMLElement).dataset.action).toBe("overwrite");
    click('.confirm-dialog [data-action="cancel"]');
    await expect(cancelled).resolves.toBeNull();
    const overlay = chooseConflict("x");
    click(".confirm-dialog .dialog-overlay");
    await expect(overlay).resolves.toBeNull();
    const escaped = chooseConflict("x");
    press("Escape");
    await expect(escaped).resolves.toBeNull();
  });

  it("does not pick a policy on Enter", () => {
    void chooseConflict("x");
    press("Enter");
    expect(document.querySelector(".confirm-dialog")).not.toBeNull();
  });
});

describe("prompt keys", () => {
  it("ignores other keys", () => {
    void prompt("Name", "n", "a");
    const input = document.querySelector<HTMLInputElement>(".prompt-input");
    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(document.querySelector(".prompt-dialog")).not.toBeNull();
  });

  it("Enter on the focused Cancel button cancels instead of accepting", async () => {
    const p = prompt("Name", "n", "typed");
    document.querySelector<HTMLButtonElement>('.prompt-dialog [data-action="cancel"]')?.focus();
    press("Enter");
    expect(await p).toBeNull();
  });

  it("Enter accepts once focus fell back to the body", async () => {
    const p = prompt("Name", "n", "typed");
    (document.activeElement as HTMLElement | null)?.blur();
    press("Enter");
    expect(await p).toBe("typed");
  });

  it("a key reaches only the newest dialog", async () => {
    const below = prompt("Name", "n", "typed");
    const above = confirm("sure?");
    press("Escape");
    expect(await above).toBe(false);
    expect(document.querySelector(".prompt-dialog")).not.toBeNull();
    press("Escape");
    expect(await below).toBeNull();
  });
});
