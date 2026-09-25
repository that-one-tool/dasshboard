/**
 * @vitest-environment happy-dom
 *
 * DOM-level tests for the trusted-hosts management dialog: rendering rows and
 * the empty state, the danger-confirmed forget flow (and its cancel path), the
 * post-forget refresh, dismissal, and load-error surfacing.
 *
 * Uses the same `vi.mock("../ipc", ...)` pattern as `hostKeyDialog.test.ts`,
 * and mocks `../ui/confirm` so the forget confirmation is deterministic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { KnownHostEntry } from "../ipc";

const h = vi.hoisted(() => ({
  list: vi.fn<() => Promise<KnownHostEntry[]>>(),
  forget: vi.fn<(id: string) => Promise<void>>(),
  confirm: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("../ipc", () => ({
  listKnownHosts: () => h.list(),
  forgetHost: (id: string) => h.forget(id),
}));
vi.mock("../ui/confirm", () => ({
  confirm: () => h.confirm(),
}));

import { openKnownHostsDialog } from "./knownHostsDialog";

function q<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`test: element not found: ${selector}`);
  return el;
}
function qa<T extends Element>(selector: string): T[] {
  return Array.from(document.querySelectorAll<T>(selector));
}
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function entry(overrides: Partial<KnownHostEntry> = {}): KnownHostEntry {
  return {
    id: "10.0.0.1:22",
    keyType: "ssh-ed25519",
    fingerprint: "SHA256:abc",
    ...overrides,
  };
}

describe("openKnownHostsDialog", () => {
  const onError = vi.fn();

  beforeEach(() => {
    document.body.innerHTML = "";
    h.list.mockReset();
    h.forget.mockReset().mockResolvedValue(undefined);
    h.confirm.mockReset();
    onError.mockReset();
  });

  it("renders a row per trusted host", async () => {
    h.list.mockResolvedValue([
      entry({ id: "a.example:22" }),
      entry({ id: "b.example:2222", fingerprint: "SHA256:xyz" }),
    ]);
    openKnownHostsDialog({ onError });
    await flush();

    const rows = qa<HTMLElement>(".known-hosts-row");
    expect(rows).toHaveLength(2);
    expect(q<HTMLElement>(".known-hosts-id").textContent).toBe("a.example:22");
    const fps = qa<HTMLElement>(".known-hosts-fp");
    expect(fps[1]?.textContent).toContain("SHA256:xyz");
    expect(onError).not.toHaveBeenCalled();
  });

  it("shows an empty state when there are no trusted hosts", async () => {
    h.list.mockResolvedValue([]);
    openKnownHostsDialog({ onError });
    await flush();

    expect(qa(".known-hosts-row")).toHaveLength(0);
    expect(q<HTMLElement>(".known-hosts-empty").textContent).toBe("No trusted hosts yet.");
  });

  it("forgets a host after a confirmed prompt, then refreshes", async () => {
    h.list.mockResolvedValueOnce([entry({ id: "gone.example:22" })]);
    h.confirm.mockResolvedValue(true);
    h.list.mockResolvedValueOnce([]); // the post-forget reload sees it gone

    openKnownHostsDialog({ onError });
    await flush();

    q<HTMLButtonElement>(".known-hosts-forget").click();
    await flush();

    expect(h.forget).toHaveBeenCalledWith("gone.example:22");
    expect(h.list).toHaveBeenCalledTimes(2);
    expect(q<HTMLElement>(".known-hosts-empty")).toBeTruthy();
  });

  it("does not forget when the confirmation is cancelled", async () => {
    h.list.mockResolvedValue([entry()]);
    h.confirm.mockResolvedValue(false);

    openKnownHostsDialog({ onError });
    await flush();

    q<HTMLButtonElement>(".known-hosts-forget").click();
    await flush();

    expect(h.forget).not.toHaveBeenCalled();
    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it("closes on the Close button", async () => {
    h.list.mockResolvedValue([]);
    openKnownHostsDialog({ onError });
    await flush();

    q<HTMLButtonElement>('[data-action="close"]').click();
    expect(document.querySelector(".known-hosts-dialog")).toBeNull();
  });

  it("closes on Escape", async () => {
    h.list.mockResolvedValue([]);
    openKnownHostsDialog({ onError });
    await flush();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".known-hosts-dialog")).toBeNull();
  });

  it("surfaces a load failure via onError", async () => {
    h.list.mockRejectedValue({ code: "Io", message: "disk gone" });
    openKnownHostsDialog({ onError });
    await flush();

    expect(onError).toHaveBeenCalledWith("disk gone");
  });

  it("surfaces a forget failure via onError and keeps the dialog open", async () => {
    h.list.mockResolvedValue([entry()]);
    h.confirm.mockResolvedValue(true);
    h.forget.mockRejectedValue({ code: "Io", message: "write failed" });

    openKnownHostsDialog({ onError });
    await flush();
    q<HTMLButtonElement>(".known-hosts-forget").click();
    await flush();

    expect(onError).toHaveBeenCalledWith("write failed");
    expect(document.querySelector(".known-hosts-dialog")).toBeTruthy();
  });
});
