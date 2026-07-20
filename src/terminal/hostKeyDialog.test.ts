/**
 * @vitest-environment happy-dom
 *
 * DOM-level regression tests for the security-relevant host-key trust dialog
 * (F6). Covers the queue (`queue.push`/`showNext`), the Escape-rejects-by-
 * default safe fallback, and the danger-styling toggle for a *changed* key
 * (possible MITM) versus a first-contact (TOFU) key.
 *
 * Uses the same `vi.mock("../ipc", ...)` pattern as `pane.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HostKeyPromptEvent } from "../ipc";

const h = vi.hoisted(() => ({
  promptHandler: null as ((event: HostKeyPromptEvent) => void) | null,
  respond: vi.fn(async (_promptId: string, _accept: boolean) => {}),
}));

vi.mock("../ipc", () => ({
  onHostKeyPrompt: vi.fn(async (handler: (event: HostKeyPromptEvent) => void) => {
    h.promptHandler = handler;
    return () => {};
  }),
  respondHostKey: (promptId: string, accept: boolean) => h.respond(promptId, accept),
}));

// Imported after the mock is registered so the module graph uses it.
import { initHostKeyDialog } from "./hostKeyDialog";

function q<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`test: element not found: ${selector}`);
  return el;
}

/** Let queued microtasks (the awaited onHostKeyPrompt/respondHostKey chains) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function promptEvent(overrides: Partial<HostKeyPromptEvent> = {}): HostKeyPromptEvent {
  return {
    promptId: "p1",
    host: "10.0.0.1",
    port: 22,
    keyType: "ssh-ed25519",
    fingerprint: "SHA256:abc",
    changed: false,
    ...overrides,
  };
}

describe("initHostKeyDialog", () => {
  let dispose: () => void;

  beforeEach(async () => {
    document.body.innerHTML = "";
    h.promptHandler = null;
    h.respond.mockClear();
    dispose = initHostKeyDialog();
    await flush(); // let the onHostKeyPrompt registration promise resolve
  });

  afterEach(() => {
    dispose();
  });

  it("shows a prompt as soon as it arrives", () => {
    h.promptHandler?.(promptEvent());

    const root = q<HTMLElement>(".hostkey-dialog");
    expect(root.classList.contains("dialog-hidden")).toBe(false);
    expect(root.getAttribute("aria-hidden")).toBe("false");
    expect(q<HTMLElement>(".hostkey-host").textContent).toBe("10.0.0.1:22");
  });

  it("queues a second concurrent prompt and shows it only after the first is resolved", async () => {
    h.promptHandler?.(promptEvent({ promptId: "p1", host: "host-a" }));
    h.promptHandler?.(promptEvent({ promptId: "p2", host: "host-b" }));

    // The second prompt is queued, not shown yet.
    expect(q<HTMLElement>(".hostkey-host").textContent).toBe("host-a:22");

    q<HTMLButtonElement>('[data-hostkey-action="trust"]').dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await flush();

    expect(h.respond).toHaveBeenCalledWith("p1", true);
    // showNext() dequeued the second prompt.
    expect(q<HTMLElement>(".hostkey-host").textContent).toBe("host-b:22");
  });

  it("hides the dialog once the queue is drained", async () => {
    h.promptHandler?.(promptEvent());

    q<HTMLButtonElement>('[data-hostkey-action="reject"]').dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await flush();

    const root = q<HTMLElement>(".hostkey-dialog");
    expect(root.classList.contains("dialog-hidden")).toBe(true);
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(h.respond).toHaveBeenCalledWith("p1", false);
  });

  it("Escape rejects the current prompt (safe default)", async () => {
    h.promptHandler?.(promptEvent({ promptId: "p1" }));

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await flush();

    expect(h.respond).toHaveBeenCalledWith("p1", false);
  });

  it("Escape is a no-op when no prompt is currently showing", async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await flush();

    expect(h.respond).not.toHaveBeenCalled();
  });

  it("focuses Reject by default so a stray Enter/Space never trusts the key", () => {
    h.promptHandler?.(promptEvent());

    expect(document.activeElement).toBe(
      q<HTMLButtonElement>('[data-hostkey-action="reject"]'),
    );
  });

  it("applies danger styling and MITM-warning copy for a changed key", () => {
    h.promptHandler?.(promptEvent({ changed: true }));

    const content = q<HTMLElement>(".hostkey-content");
    expect(content.classList.contains("hostkey-danger")).toBe(true);
    expect(q<HTMLElement>(".hostkey-heading").textContent).toContain("changed");
  });

  it("does not apply danger styling for a first-contact (unknown) key", () => {
    h.promptHandler?.(promptEvent({ changed: false }));

    const content = q<HTMLElement>(".hostkey-content");
    expect(content.classList.contains("hostkey-danger")).toBe(false);
  });

  it("dispose() removes the dialog and stops reacting to Escape", async () => {
    h.promptHandler?.(promptEvent());
    dispose();

    expect(document.querySelector(".hostkey-dialog")).toBeNull();

    h.respond.mockClear();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await flush();
    expect(h.respond).not.toHaveBeenCalled();
  });
});
