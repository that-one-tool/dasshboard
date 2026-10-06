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
  closedHandler: null as ((promptId: string) => void) | null,
  respond: vi.fn(async (_promptId: string, _accept: boolean) => {}),
}));

vi.mock("../ipc", () => ({
  onHostKeyPrompt: vi.fn(async (handler: (event: HostKeyPromptEvent) => void) => {
    h.promptHandler = handler;
    return () => {};
  }),
  onHostKeyPromptClosed: vi.fn(async (handler: (promptId: string) => void) => {
    h.closedHandler = handler;
    return () => {};
  }),
  respondHostKey: (promptId: string, accept: boolean) => h.respond(promptId, accept),
}));

// Imported after the mock is registered so the module graph uses it.
import { initHostKeyDialog, TRUST_ARM_DELAY_MS } from "./hostKeyDialog";
import { applyDomTranslations, setLocale } from "../i18n";

function q<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`test: element not found: ${selector}`);
  return el;
}

/** Let queued microtasks (the awaited onHostKeyPrompt/respondHostKey chains) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** Click Trust once the prompt on screen has armed it. */
function clickTrust(): void {
  vi.advanceTimersByTime(TRUST_ARM_DELAY_MS);
  clickTrustNow();
}

function clickTrustNow(): void {
  q<HTMLButtonElement>('[data-hostkey-action="trust"]').dispatchEvent(
    new MouseEvent("click", { bubbles: true }),
  );
}

function promptEvent(overrides: Partial<HostKeyPromptEvent> = {}): HostKeyPromptEvent {
  return {
    promptId: "p1",
    host: "10.0.0.1",
    port: 22,
    keyType: "ssh-ed25519",
    fingerprint: "SHA256:abc",
    changed: false,
    trustReset: false,
    ...overrides,
  };
}

describe("initHostKeyDialog", () => {
  let dispose: () => void;

  beforeEach(async () => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    h.promptHandler = null;
    h.respond.mockClear();
    dispose = initHostKeyDialog();
    await flush(); // let the onHostKeyPrompt registration promise resolve
  });

  afterEach(() => {
    dispose();
    vi.useRealTimers();
  });

  // A prompt can swap in under the cursor (the previous one answered or
  // dropped): a click meant for the old one must not trust the new one.
  it("arms Trust only a moment after a prompt appears", async () => {
    h.promptHandler?.(promptEvent());
    const trust = q<HTMLButtonElement>('[data-hostkey-action="trust"]');
    expect(trust.disabled).toBe(true);

    clickTrustNow();
    await flush();
    expect(h.respond).not.toHaveBeenCalled();

    clickTrust();
    await flush();
    expect(h.respond).toHaveBeenCalledWith("p1", true);
  });

  it("re-arms the delay when the next prompt swaps in", async () => {
    h.promptHandler?.(promptEvent({ promptId: "p1", host: "host-a" }));
    h.promptHandler?.(promptEvent({ promptId: "p2", host: "host-b" }));
    clickTrust();
    await flush();

    clickTrustNow(); // the second click of a double-click
    await flush();

    expect(h.respond).not.toHaveBeenCalledWith("p2", expect.anything());
    expect(q<HTMLButtonElement>('[data-hostkey-action="trust"]').disabled).toBe(true);
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

    clickTrust();
    await flush();

    expect(h.respond).toHaveBeenCalledWith("p1", true);
    // showNext() dequeued the second prompt.
    expect(q<HTMLElement>(".hostkey-host").textContent).toBe("host-b:22");
  });

  it("drops the shown prompt once the backend stops waiting on it", () => {
    h.promptHandler?.(promptEvent({ promptId: "p1", host: "host-a" }));
    h.promptHandler?.(promptEvent({ promptId: "p2", host: "host-b" }));

    h.closedHandler?.("p1");

    expect(q<HTMLElement>(".hostkey-host").textContent).toBe("host-b:22");
    expect(h.respond).not.toHaveBeenCalled();
  });

  it("drops a queued prompt the backend stopped waiting on", async () => {
    h.promptHandler?.(promptEvent({ promptId: "p1", host: "host-a" }));
    h.promptHandler?.(promptEvent({ promptId: "p2", host: "host-b" }));
    h.closedHandler?.("p2");

    q<HTMLButtonElement>('[data-hostkey-action="reject"]').dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await flush();

    expect(q<HTMLElement>(".hostkey-dialog").classList.contains("dialog-hidden")).toBe(true);
  });

  it("ignores a closed notice for a prompt it already answered", async () => {
    h.promptHandler?.(promptEvent({ promptId: "p1", host: "host-a" }));
    h.promptHandler?.(promptEvent({ promptId: "p2", host: "host-b" }));
    clickTrust();
    await flush();

    h.closedHandler?.("p1");
    expect(q<HTMLElement>(".hostkey-host").textContent).toBe("host-b:22");
  });

  it("applies one answer to every queued prompt for the same host key", async () => {
    // e.g. a profile opening four panes to the same new host.
    h.promptHandler?.(promptEvent({ promptId: "p1" }));
    h.promptHandler?.(promptEvent({ promptId: "p2" }));
    h.promptHandler?.(promptEvent({ promptId: "p3", host: "other" }));

    clickTrust();
    await flush();

    expect(h.respond).toHaveBeenCalledWith("p1", true);
    expect(h.respond).toHaveBeenCalledWith("p2", true);
    expect(h.respond).not.toHaveBeenCalledWith("p3", expect.anything());
    expect(q<HTMLElement>(".hostkey-host").textContent).toBe("other:22");
  });

  it("never lets an unknown-key answer approve a queued changed-key prompt", async () => {
    h.promptHandler?.(promptEvent({ promptId: "p1", changed: false }));
    h.promptHandler?.(promptEvent({ promptId: "p2", changed: true }));

    clickTrust();
    await flush();

    expect(h.respond).toHaveBeenCalledWith("p1", true);
    expect(h.respond).not.toHaveBeenCalledWith("p2", expect.anything());
    // The changed key still gets its own, loud prompt.
    expect(q<HTMLElement>(".hostkey-content").classList.contains("hostkey-danger")).toBe(true);
  });

  it("never lets a plain answer approve a queued trust-reset prompt", async () => {
    h.promptHandler?.(promptEvent({ promptId: "p1" }));
    h.promptHandler?.(promptEvent({ promptId: "p2", trustReset: true }));

    clickTrust();
    await flush();

    expect(h.respond).not.toHaveBeenCalledWith("p2", expect.anything());
    expect(q<HTMLElement>(".hostkey-content").classList.contains("hostkey-danger")).toBe(true);
  });

  it("relabels its static text when the language changes", () => {
    try {
      setLocale("fr");
      applyDomTranslations(document);
      expect(q<HTMLElement>('[data-hostkey-action="reject"]').textContent?.trim()).toBe("Rejeter");
      expect(q<HTMLElement>(".hostkey-facts dt").textContent).toBe("Hôte");
    } finally {
      setLocale("en");
    }
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

  it("shows over a confirm opened before it, and takes its keys", async () => {
    const { confirm } = await import("../ui/confirm");
    let pasteAnswer: boolean | null = null;
    const paste = confirm("Paste 3 lines?").then((r) => (pasteAnswer = r));
    h.promptHandler?.(promptEvent());

    // Every dialog shares one z-index, so the later sibling paints on top: the
    // prompt must be the last one, or the keys would go to a hidden dialog.
    expect(document.body.lastElementChild).toBe(q(".hostkey-dialog"));

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();

    expect(h.respond).toHaveBeenCalledWith("p1", false);
    expect(pasteAnswer).toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await paste;
    expect(pasteAnswer).toBe(false);
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
