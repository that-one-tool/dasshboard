/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AuthPromptEvent } from "../ipc";

const h = vi.hoisted(() => ({
  promptHandler: null as ((event: AuthPromptEvent) => void) | null,
  closedHandler: null as ((promptId: string) => void) | null,
  respond: vi.fn(async (_promptId: string, _answers: string[] | null) => {}),
  shown: vi.fn(async (_promptId: string) => {}),
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
  markAuthPromptShown: (promptId: string) => h.shown(promptId),
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
  let clock: number;
  let monotonicNow: ReturnType<typeof vi.spyOn>;
  /** Past the time a new prompt ignores Enter and Escape. */
  const later = (): void => {
    clock += 1500;
  };

  beforeEach(async () => {
    clock = 100_000;
    monotonicNow = vi.spyOn(performance, "now").mockImplementation(() => clock);
    document.body.innerHTML = "";
    h.respond.mockClear();
    h.shown.mockClear();
    dispose = initAuthPromptDialog();
    await flush();
  });

  afterEach(() => {
    dispose();
    monotonicNow.mockRestore();
  });

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

  it("doesn't take the keys of a user typing elsewhere", () => {
    const terminal = document.createElement("textarea");
    document.body.append(terminal);
    terminal.focus();
    terminal.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true }));

    show(promptEvent());

    expect(document.activeElement).toBe(q(".authprompt-form"));
  });

  it("focuses the field once the user stopped typing", () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true }));
    later();

    show(promptEvent());

    expect(document.activeElement).toBe(inputs()[0]);
  });

  it("after an answer, the next prompt's field takes the next code", async () => {
    show(promptEvent({ promptId: "a1" }));
    show(promptEvent({ promptId: "a2", host: "10.0.0.2" }));
    later();
    inputs()[0]!.value = "111111";
    inputs()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    submit();
    await flush();

    expect(q(".authprompt-lead").textContent).toContain("root@10.0.0.2:22");
    expect(document.activeElement).toBe(inputs()[0]);
  });

  it("an Enter repeated into the next prompt answers nothing", async () => {
    show(promptEvent({ promptId: "a1" }));
    show(promptEvent({ promptId: "a2", host: "10.0.0.2" }));
    later();
    inputs()[0]!.value = "111111";
    submit();
    submit();
    await flush();

    expect(h.respond.mock.calls).toEqual([["a1", ["111111"]]]);
    later();
    submit();
    await flush();
    expect(h.respond).toHaveBeenLastCalledWith("a2", [""]);
  });

  it("a system clock set back doesn't lock the prompt", async () => {
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    show(promptEvent());
    wallClock.mockReturnValue(0);
    later();

    submit();
    await flush();

    expect(h.respond).toHaveBeenCalledWith("a1", [""]);
    wallClock.mockRestore();
  });

  it("an Escape pressed as a prompt appears doesn't cancel it", async () => {
    show(promptEvent());
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();

    expect(h.respond).not.toHaveBeenCalled();
    expect(root().classList.contains("dialog-hidden")).toBe(false);
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
    later();

    submit();
    await flush();

    expect(h.respond).toHaveBeenCalledWith("a1", ["pw", "123456"]);
    expect(inputs()).toHaveLength(0);
    expect(root().classList.contains("dialog-hidden")).toBe(true);
  });

  it("shows queued prompts one after the other", async () => {
    show(promptEvent({ promptId: "a1" }));
    show(promptEvent({ promptId: "a2", host: "second.host" }));
    later();

    submit();
    await flush();

    expect(root().classList.contains("dialog-hidden")).toBe(false);
    expect(q(".authprompt-lead").textContent).toContain("second.host");
  });

  it("tells the backend when each prompt is on screen, not while queued", async () => {
    show(promptEvent({ promptId: "a1" }));
    show(promptEvent({ promptId: "a2" }));
    expect(h.shown.mock.calls).toEqual([["a1"]]);
    later();

    submit();
    await flush();

    expect(h.shown.mock.calls).toEqual([["a1"], ["a2"]]);
  });

  it("a failed shown notice is ignored", async () => {
    h.shown.mockRejectedValueOnce(new Error("ipc down"));
    show(promptEvent());
    await flush();
    expect(root().classList.contains("dialog-hidden")).toBe(false);
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
    later();
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
    later();
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
    later();
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
