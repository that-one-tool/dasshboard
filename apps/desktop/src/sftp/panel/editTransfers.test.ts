import { describe, it, expect, vi } from "vitest";
import { EditTransfers } from "./editTransfers";
import type { EnqueueSpec, TransferItem } from "../transferQueue";
import { t } from "../../i18n";

function setup() {
  const specs: EnqueueSpec[] = [];
  const transfers = new EditTransfers((spec) => specs.push(spec));
  return { specs, transfers };
}

function item(id: number, state: TransferItem["state"], error?: TransferItem["error"]): TransferItem {
  return { id, deviceId: "a", direction: "upload", isDir: false, name: "f", cancellable: false, state, transferred: 0, total: 0, error };
}

const spec = (deviceId = "a") => ({
  deviceId,
  direction: "upload" as const,
  name: "f",
  cancellable: false,
  run: vi.fn(async () => "uploaded"),
});

describe("EditTransfers", () => {
  it("queues the transfer as a single, non-folder item", () => {
    const { specs, transfers } = setup();
    void transfers.run(spec());
    expect(specs[0]).toMatchObject({ deviceId: "a", direction: "upload", isDir: false, name: "f", cancellable: false });
  });

  it("settles with the run's result", async () => {
    const { specs, transfers } = setup();
    const result = transfers.run(spec());
    await specs[0]?.run();
    await expect(result).resolves.toBe("uploaded");
  });

  it("rejects, and still fails the queue item, when the run fails", async () => {
    const { specs, transfers } = setup();
    const failing = { ...spec(), run: vi.fn(async () => Promise.reject(new Error("boom"))) };
    const result = transfers.run(failing);
    await expect(specs[0]?.run()).rejects.toThrow("boom");
    await expect(result).rejects.toThrow("boom");
  });

  it("rejects an item the queue ended without running", async () => {
    const { transfers } = setup();
    const cancelled = transfers.run(spec());
    transfers.settle(item(1, "cancelled"));
    await expect(cancelled).rejects.toEqual({ code: "Cancelled", message: t("sftp.transferCancelled") });

    const failed = transfers.run(spec());
    transfers.settle(item(2, "failed", { code: "Sftp", message: "gone" }));
    await expect(failed).rejects.toEqual({ code: "Sftp", message: "gone" });
  });

  it("leaves a done item and an unknown one alone", () => {
    const { transfers } = setup();
    expect(() => transfers.settle(item(9, "cancelled"))).not.toThrow();
    void transfers.run(spec());
    transfers.settle(item(1, "done"));
  });

  it("rejects only the given device's pending transfers", async () => {
    const { transfers } = setup();
    const onA = transfers.run(spec("a"));
    const onB = transfers.run(spec("b"));
    const settledB = vi.fn();
    onB.catch(settledB);
    transfers.rejectDevice("a");
    await expect(onA).rejects.toMatchObject({ code: "Cancelled" });
    await Promise.resolve();
    expect(settledB).not.toHaveBeenCalled();
  });
});
