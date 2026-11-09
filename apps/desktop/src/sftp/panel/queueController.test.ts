/** @vitest-environment happy-dom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../ipc", () => ({ sftpCancelTransfer: vi.fn(async () => {}) }));

import { sftpCancelTransfer } from "../../ipc";
import { QueueController } from "./queueController";
import { buildPanelElements } from "./panelElements";
import { PanelFeedback } from "./panelFeedback";

function setup() {
  const els = buildPanelElements(document.createElement("aside"));
  const hooks = { notifyError: vi.fn(), notifySuccess: vi.fn(), resync: vi.fn() };
  const onLanded = vi.fn();
  const queue = new QueueController({ els: () => els, feedback: new PanelFeedback(hooks), onLanded });
  return { els, hooks, onLanded, queue };
}

function pending(): { run: () => Promise<void>; finish: () => void; fail: (err: unknown) => void } {
  let finish!: () => void;
  let fail!: (err: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  return { run: () => promise, finish, fail };
}

const spec = { deviceId: "a", direction: "download" as const, isDir: false, name: "f" };

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("QueueController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => vi.useRealTimers());

  it("renders queued items and updates the active row's progress in place", () => {
    const { els, queue } = setup();
    queue.enqueue({ ...spec, run: pending().run });
    const row = els.queue.querySelector(".sftp-queue-item");
    expect(els.queue.hidden).toBe(false);

    queue.applyProgress("a", 25, 100);
    expect(els.queue.querySelector(".sftp-queue-item")).toBe(row);
    expect(els.queue.querySelector(".sftp-queue-pct")?.textContent).toBe("25%");
  });

  it("re-renders on progress for a row not rendered yet", () => {
    const { els, queue } = setup();
    queue.enqueue({ ...spec, run: pending().run });
    els.queue.replaceChildren();
    queue.applyProgress("a", 50, 100);
    expect(els.queue.querySelector(".sftp-queue-pct")?.textContent).toBe("50%");
  });

  it("a success toasts, reports where an upload landed, then hides its row", async () => {
    const { els, hooks, onLanded, queue } = setup();
    queue.enqueue({ ...spec, run: async () => {}, successToast: "ok", refreshDir: "/home" });
    await settle();
    expect(hooks.notifySuccess).toHaveBeenCalledWith("ok");
    expect(onLanded).toHaveBeenCalledWith("a", "/home");
    expect(els.queue.querySelector(".is-done")).not.toBeNull();

    vi.advanceTimersByTime(3000);
    expect(els.queue.querySelector(".sftp-queue-item")).toBeNull();
  });

  it("a quiet success neither toasts nor re-lists", async () => {
    const { hooks, onLanded, queue } = setup();
    queue.enqueue({ ...spec, run: async () => {} });
    await settle();
    expect(hooks.notifySuccess).not.toHaveBeenCalled();
    expect(onLanded).not.toHaveBeenCalled();
  });

  it("a failure is reported and its row stays until dismissed", async () => {
    const { els, hooks, queue } = setup();
    const error = { code: "Sftp", message: "denied" };
    const id = queue.enqueue({ ...spec, run: async () => Promise.reject(error) });
    await settle();
    expect(hooks.notifyError).toHaveBeenCalledWith(error);
    expect(hooks.resync).toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(els.queue.querySelector(".is-failed")).not.toBeNull();

    queue.dismiss(id);
    expect(els.queue.querySelector(".sftp-queue-item")).toBeNull();
  });

  it("a cancelled item is quiet", async () => {
    const { hooks, queue } = setup();
    queue.enqueue({ ...spec, run: async () => Promise.reject({ code: "Cancelled", message: "" }) });
    await settle();
    expect(hooks.notifyError).not.toHaveBeenCalled();
  });

  it("dismissing a done row early stops its hide timer", async () => {
    const { els, queue } = setup();
    const id = queue.enqueue({ ...spec, run: async () => {} });
    await settle();
    queue.dismiss(id);
    expect(els.queue.querySelector(".sftp-queue-item")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clearFinished drops ended rows and their timers", async () => {
    const { els, queue } = setup();
    queue.enqueue({ ...spec, run: async () => {} });
    await settle();
    queue.clearFinished();
    expect(els.queue.querySelector(".sftp-queue-item")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("dispose clears pending hide timers", async () => {
    const { queue } = setup();
    queue.enqueue({ ...spec, run: async () => {} });
    await settle();
    queue.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancelling the active item asks the backend, and reports a failed cancel", async () => {
    const { hooks, queue } = setup();
    const id = queue.enqueue({ ...spec, run: pending().run });
    queue.cancel(id);
    expect(sftpCancelTransfer).toHaveBeenCalledWith("a");

    vi.mocked(sftpCancelTransfer).mockRejectedValueOnce({ code: "Sftp", message: "gone" });
    queue.cancel(id);
    await settle();
    expect(hooks.notifyError).toHaveBeenCalledWith({ code: "Sftp", message: "gone" });
  });

  it("cancelDevice drops the device's items and rejects its edit transfers", async () => {
    const { els, queue } = setup();
    queue.enqueue({ ...spec, run: pending().run });
    const edit = queue.edits.run({ deviceId: "a", direction: "upload", name: "e", cancellable: false, run: async () => 1 });

    queue.cancelDevice("a");
    await expect(edit).rejects.toMatchObject({ code: "Cancelled" });
    expect(els.queue.querySelector(".sftp-queue-item")).toBeNull();
  });
});
