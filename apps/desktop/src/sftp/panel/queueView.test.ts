/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect } from "vitest";
import { t } from "../../i18n";
import type { TransferItem, TransferState } from "../transferQueue";
import { renderQueue, updateQueueRowProgress } from "./queueView";

function item(id: number, state: TransferState, extra: Partial<TransferItem> = {}): TransferItem {
  return {
    id,
    deviceId: "d1",
    direction: "download",
    isDir: false,
    name: `file${id}.txt`,
    cancellable: true,
    state,
    transferred: 0,
    total: 0,
    ...extra,
  };
}

function rendered(...items: TransferItem[]): HTMLElement {
  const el = document.createElement("div");
  renderQueue(el, items);
  return el;
}

const row = (el: HTMLElement, id: number) =>
  el.querySelector<HTMLElement>(`.sftp-queue-item[data-tx-id="${id}"]`);

describe("renderQueue", () => {
  it("hides the list when there is nothing queued", () => {
    const el = rendered();
    expect(el.hidden).toBe(true);
    expect(el.children.length).toBe(0);
  });

  it("shows each item as a row with its state class and name as text", () => {
    const el = rendered(item(1, "queued", { name: "<b>x</b>" }));
    expect(el.hidden).toBe(false);
    expect(row(el, 1)?.classList.contains("is-queued")).toBe(true);
    expect(row(el, 1)?.querySelector(".sftp-queue-name")?.textContent).toBe("<b>x</b>");
  });

  it("offers Clear only once some item finished", () => {
    expect(rendered(item(1, "active")).querySelector('[data-action="tx-clear"]')).toBeNull();
    expect(rendered(item(1, "done")).querySelector('[data-action="tx-clear"]')).not.toBeNull();
  });

  it("shows an active item's progress as a percentage, or bytes when the total is unknown", () => {
    const el = rendered(item(1, "active", { transferred: 50, total: 200 }), item(2, "active", { transferred: 2048 }));
    expect(row(el, 1)?.querySelector<HTMLElement>(".sftp-queue-fill")?.style.width).toBe("25%");
    expect(row(el, 1)?.querySelector(".sftp-queue-pct")?.textContent).toBe("25%");
    expect(row(el, 2)?.querySelector(".sftp-queue-pct")?.textContent).not.toContain("%");
  });

  it("labels the other states", () => {
    const el = rendered(item(1, "queued"), item(2, "done"), item(3, "failed"), item(4, "cancelled"));
    const detail = (id: number) => row(el, id)?.querySelector(".sftp-queue-detail")?.textContent;
    expect(detail(1)).toBe(t("sftp.queue.queued"));
    expect(detail(2)).toContain(t("sftp.progress.done"));
    expect(detail(3)).toBe(t("sftp.queue.failed"));
    expect(detail(4)).toBe(t("sftp.transferCancelled"));
  });

  it("cancels a running item, dismisses an ended one, and offers nothing on a success", () => {
    const el = rendered(item(1, "active"), item(2, "queued"), item(3, "failed"), item(4, "cancelled"), item(5, "done"));
    const action = (id: number) => row(el, id)?.querySelector<HTMLElement>(".sftp-queue-cancel")?.dataset.action;
    expect([action(1), action(2), action(3), action(4), action(5)]).toEqual([
      "tx-cancel",
      "tx-cancel",
      "tx-dismiss",
      "tx-dismiss",
      undefined,
    ]);
  });

  it("offers no cancel on an item that can't be cancelled", () => {
    const el = rendered(item(1, "active", { cancellable: false }));
    expect(row(el, 1)?.querySelector(".sftp-queue-cancel")).toBeNull();
  });
});

describe("updateQueueRowProgress", () => {
  it("updates a rendered row's bar in place", () => {
    const el = rendered(item(1, "active", { total: 100 }));
    const moved = updateQueueRowProgress(el, item(1, "active", { transferred: 100, total: 100 }));
    expect(moved).toBe(true);
    expect(row(el, 1)?.querySelector(".sftp-queue-pct")?.textContent).toBe("100%");
  });

  it("reports a row it can't find, so the caller re-renders", () => {
    expect(updateQueueRowProgress(rendered(), item(9, "active"))).toBe(false);
  });
});
