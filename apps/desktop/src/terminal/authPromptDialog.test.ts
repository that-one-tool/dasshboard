/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AuthPromptEvent } from "../ipc";

const h = vi.hoisted(() => ({
  promptHandler: null as ((event: AuthPromptEvent) => void) | null,
  closedHandler: null as ((promptId: string) => void) | null,
  respond: vi.fn(async (_promptId: string, _answers: string[] | null) => {}),
}));

vi.mock("../ipc", () => ({
  onAuthPrompt: vi.fn(async (handler: (event: AuthPromptEvent) => void) => {
    h.promptHandler = handler;
    return () => {};
  }),
  onAuthPromptClosed: vi.fn(async (handler: (promptId: string) => void) => {
    h.closedHandler = handler;
    return () => {};
  }),
  respondAuthPrompt: (promptId: string, answers: string[] | null) => h.respond(promptId, answers),
}));

import { initAuthPromptDialog } from "./authPromptDialog";
import { pushDialog, removeDialog } from "../ui/dialogStack";

function q<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`test: element not found: ${selector}`);
  return el;
}

function root(): HTMLElement {
  return q<HTMLElement>(".authprompt-dialog");
}

function inputs(): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>(".authprompt-fields input")];
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function promptEvent(overrides: Partial<AuthPromptEvent> = {}): AuthPromptEvent {
  return {
    promptId: "a1",
    host: "10.0.0.1",
    port: 22,
    username: "root",
    name: "",
    instructions: "",
    fields: [{ label: "Verification code: ", echo: false }],
    ...overrides,
  };
}

function show(event: AuthPromptEvent): void {
  h.promptHandler?.(event);
}

function submit(): void {
  q<HTMLFormElement>(".authprompt-form").dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
}

describe("initAuthPromptDialog", () => {
  let dispose: () => void;

  beforeEach(async () => {
    document.body.innerHTML = "";
    h.respond.mockClear();
    dispose = initAuthPromptDialog();
    await flush();
  });

  afterEach(() => dispose());

  it("starts hidden", () => {
    expect(root().classList.contains("dialog-hidden")).toBe(true);
  });

  it("shows who asks and one input per field, hidden when the server says so", () => {
    show(
      promptEvent({
        fields: [
          { label: "Password: ", echo: false },
          { label: "Token name: ", echo: true },
        ],
      }),
    );

    expect(root().classList.contains("dialog-hidden")).toBe(false);
    expect(q(".authprompt-lead").textContent).toContain("root@10.0.0.1:22");
    const [secret, visible] = inputs();
    expect(secret?.type).toBe("password");
    expect(visible?.type).toBe("text");
    const labels = [...document.querySelectorAll(".authprompt-fields label")];
    expect(labels.map((l) => l.textContent)).toEqual(["Password: ", "Token name: "]);
    expect(document.activeElement).toBe(secret);
  });

  it("puts the server's texts in as plain text", () => {
    show(
      promptEvent({
        name: "<b>name</b>",
        instructions: "<img src=x>",
        fields: [{ label: "<i>code</i>", echo: false }],
      }),
    );

    expect(q(".authprompt-name").textContent).toBe("<b>name</b>");
    expect(q(".authprompt-instructions").textContent).toBe("<img src=x>");
    expect(document.querySelector(".authprompt-dialog b, .authprompt-dialog img, .authprompt-dialog i")).toBeNull();
  });

  it("hides an empty name and instructions", () => {
    show(promptEvent());
    expect(q<HTMLElement>(".authprompt-name").hidden).toBe(true);
    expect(q<HTMLElement>(".authprompt-instructions").hidden).toBe(true);
  });

  it("submits the answers in order, clears them and closes", async () => {
    show(promptEvent({ fields: [{ label: "A", echo: false }, { label: "B", echo: true }] }));
    const [first, second] = inputs();
    first!.value = "pw";
    second!.value = "123456";

    submit();
    await flush();

    expect(h.respond).toHaveBeenCalledWith("a1", ["pw", "123456"]);
    expect(inputs()).toHaveLength(0);
    expect(root().classList.contains("dialog-hidden")).toBe(true);
  });

  it("shows queued prompts one after the other", async () => {
    show(promptEvent({ promptId: "a1" }));
    show(promptEvent({ promptId: "a2", host: "second.host" }));

    submit();
    await flush();

    expect(root().classList.contains("dialog-hidden")).toBe(false);
    expect(q(".authprompt-lead").textContent).toContain("second.host");
  });

  it("Cancel cancels the prompt", async () => {
    show(promptEvent());
    q<HTMLButtonElement>('[data-authprompt-action="cancel"]').click();
    await flush();
    expect(h.respond).toHaveBeenCalledWith("a1", null);
    expect(root().classList.contains("dialog-hidden")).toBe(true);
  });

  it("Escape cancels the prompt", async () => {
    show(promptEvent());
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(h.respond).toHaveBeenCalledWith("a1", null);
  });

  it("a prompt the backend stopped waiting on goes away unanswered", () => {
    show(promptEvent({ promptId: "a1" }));
    show(promptEvent({ promptId: "a2", host: "second.host" }));

    h.closedHandler?.("a2");
    h.closedHandler?.("a1");

    expect(root().classList.contains("dialog-hidden")).toBe(true);
    expect(h.respond).not.toHaveBeenCalled();
  });

  it("a failed answer delivery is ignored (the backend times out)", async () => {
    h.respond.mockRejectedValueOnce(new Error("ipc down"));
    show(promptEvent());
    submit();
    await flush();
    expect(root().classList.contains("dialog-hidden")).toBe(true);
  });

  it("a round that asks nothing is shown as a toast, not a prompt", () => {
    show(promptEvent({ instructions: "Approve the push on your phone", fields: [] }));

    expect(root().classList.contains("dialog-hidden")).toBe(true);
    const toast = q(".toast-info");
    expect(toast.textContent).toContain("root@10.0.0.1:22");
    expect(toast.textContent).toContain("Approve the push on your phone");
  });

  it("Escape is left to a newer dialog on top", () => {
    show(promptEvent());
    const newer = document.createElement("div");
    pushDialog(newer);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(h.respond).not.toHaveBeenCalled();
    removeDialog(newer);
  });

  it("moving to the next prompt doesn't jump above a newer dialog", async () => {
    show(promptEvent({ promptId: "a1" }));
    show(promptEvent({ promptId: "a2" }));
    const newer = document.createElement("div");
    document.body.appendChild(newer);
    pushDialog(newer);

    h.closedHandler?.("a1");

    expect(document.body.lastElementChild).toBe(newer);
    removeDialog(newer);
  });

  it("dispose removes the dialog", () => {
    dispose();
    expect(document.querySelector(".authprompt-dialog")).toBeNull();
    dispose = () => {};
  });
});
