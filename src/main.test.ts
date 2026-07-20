/**
 * @vitest-environment happy-dom
 *
 * Unit tests for `showToast` (F7): a burst of identical back-to-back calls
 * (e.g. one `onError` per failed pane in a `Promise.allSettled`) previously
 * stacked a `.toast` node per call with no cap or dedup. These tests cover
 * the fix — dedup of an exact repeat (which just restarts its dismiss timer
 * instead of adding a node), the concurrent-toast cap, container reuse, and
 * auto-dismiss.
 *
 * `main.ts` also wires up `initApp()` via `window.addEventListener("DOMContentLoaded", ...)`,
 * but that event is never dispatched by simply importing the module in a test
 * environment, so importing it here only exercises `showToast`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { showToast } from "./main";

function toasts(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".toast"));
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("showToast container reuse", () => {
  it("creates the toast container once and reuses it across calls", () => {
    showToast("first message", "error");
    showToast("second message", "error");

    expect(document.querySelectorAll(".toast-container").length).toBe(1);
  });
});

describe("showToast dedup", () => {
  it("does not stack an exact back-to-back repeat of the same message and type", () => {
    showToast("Connection failed", "error");
    showToast("Connection failed", "error");

    expect(toasts().length).toBe(1);
  });

  it("adds a new toast when the message differs", () => {
    showToast("Connection failed: host A", "error");
    showToast("Connection failed: host B", "error");

    expect(toasts().length).toBe(2);
  });

  it("adds a new toast when the type differs even if the message matches", () => {
    showToast("Saved", "success");
    showToast("Saved", "error");

    expect(toasts().length).toBe(2);
  });

  it("only dedups against the most recent toast, not older ones", () => {
    showToast("A", "error");
    showToast("B", "error");
    showToast("A", "error"); // not back-to-back with the first "A"

    expect(toasts().length).toBe(3);
  });
});

describe("showToast concurrent cap", () => {
  it("drops the oldest toast once the cap is exceeded", () => {
    showToast("one", "error");
    showToast("two", "error");
    showToast("three", "error");
    showToast("four", "error");

    const messages = toasts().map((t) => t.textContent);
    expect(messages).not.toContain("one");
    expect(messages).toContain("four");
    expect(messages.length).toBeLessThanOrEqual(3);
  });
});

describe("showToast auto-dismiss", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("removes the toast after 4 seconds", () => {
    showToast("expires soon", "error");
    expect(toasts().length).toBe(1);

    vi.advanceTimersByTime(4000);

    expect(toasts().length).toBe(0);
  });

  it("restarts the dismiss timer on a deduped repeat instead of expiring on the original schedule", () => {
    showToast("still relevant", "error");

    vi.advanceTimersByTime(3000);
    expect(toasts().length).toBe(1); // not yet expired

    showToast("still relevant", "error"); // dedup: resets the 4s timer

    vi.advanceTimersByTime(2000); // 5s since the first call, but only 2s since the reset
    expect(toasts().length).toBe(1);

    vi.advanceTimersByTime(2000); // now 4s since the reset
    expect(toasts().length).toBe(0);
  });
});
