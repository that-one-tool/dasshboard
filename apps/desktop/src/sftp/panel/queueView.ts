/** The Files panel's background transfer list. Built with DOM APIs, so a
 * remote-supplied name goes in as text, never markup. */

import { t } from "../../i18n";
import { downloadIcon, uploadIcon } from "../../ui/icons";
import { formatSize } from "../sftpFormat";
import type { TransferItem, TransferState } from "../transferQueue";

type RowAction = "tx-cancel" | "tx-dismiss";

interface StateView {
  detail: (item: TransferItem) => (Node | string)[];
  action: RowAction | null;
}

const STATE_VIEWS: Record<TransferState, StateView> = {
  active: { detail: (item) => progressNodes(item), action: "tx-cancel" },
  queued: { detail: () => [t("sftp.queue.queued")], action: "tx-cancel" },
  done: { detail: () => [`✓ ${t("sftp.progress.done")}`], action: null },
  failed: { detail: () => [t("sftp.queue.failed")], action: "tx-dismiss" },
  cancelled: { detail: () => [t("sftp.transferCancelled")], action: "tx-dismiss" },
};

const ENDED: readonly TransferState[] = ["done", "failed", "cancelled"];

/** Rebuild the list (hidden when empty). */
export function renderQueue(el: HTMLElement, items: readonly TransferItem[]): void {
  el.hidden = items.length === 0;
  if (el.hidden) {
    el.replaceChildren();
    return;
  }
  const list = document.createElement("div");
  list.className = "sftp-queue-list";
  list.append(...items.map(queueRow));
  el.replaceChildren(queueHead(items), list);
}

/**
 * Update an active row's bar in place: a full rebuild per progress tick would
 * re-announce the live region and recreate the cancel button mid-click.
 * `false` when the row isn't rendered yet (the caller then re-renders).
 */
export function updateQueueRowProgress(el: HTMLElement, item: TransferItem): boolean {
  const parts = progressParts(el, item.id);
  if (!parts) return false;
  parts.fill.style.width = `${percentOf(item)}%`;
  parts.pct.textContent = progressText(item);
  return true;
}

function progressParts(el: HTMLElement, id: number): { fill: HTMLElement; pct: HTMLElement } | null {
  const row = `.sftp-queue-item[data-tx-id="${id}"]`;
  const fill = el.querySelector<HTMLElement>(`${row} .sftp-queue-fill`);
  const pct = el.querySelector<HTMLElement>(`${row} .sftp-queue-pct`);
  return fill && pct ? { fill, pct } : null;
}

function queueHead(items: readonly TransferItem[]): HTMLElement {
  const head = document.createElement("div");
  head.className = "sftp-queue-head";
  const title = document.createElement("span");
  title.className = "sftp-queue-title";
  title.textContent = t("sftp.queue.title");
  head.appendChild(title);
  if (items.some((i) => ENDED.includes(i.state))) head.appendChild(clearButton());
  return head;
}

function clearButton(): HTMLButtonElement {
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "btn btn-small";
  clear.dataset.action = "tx-clear";
  clear.textContent = t("sftp.queue.clear");
  return clear;
}

function queueRow(item: TransferItem): HTMLElement {
  const row = document.createElement("div");
  row.className = `sftp-queue-item is-${item.state}`;
  row.dataset.txId = String(item.id);
  const view = STATE_VIEWS[item.state];
  const detail = span("sftp-queue-detail");
  detail.append(...view.detail(item));
  row.append(directionIcon(item), nameSpan(item.name), detail);
  const action = rowAction(item, view.action);
  if (action) row.appendChild(rowButton(action));
  return row;
}

/** An item the user may not cancel shows no cancel button. */
function rowAction(item: TransferItem, action: RowAction | null): RowAction | null {
  return action === "tx-cancel" && !item.cancellable ? null : action;
}

function rowButton(action: RowAction): HTMLButtonElement {
  const label = action === "tx-cancel" ? t("sftp.cancelTransfer") : t("common.close");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn-icon btn-small sftp-queue-cancel";
  btn.dataset.action = action;
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.textContent = "×";
  return btn;
}

function directionIcon(item: TransferItem): HTMLElement {
  const icon = span("sftp-queue-icon");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = item.direction === "upload" ? uploadIcon : downloadIcon;
  return icon;
}

function nameSpan(name: string): HTMLElement {
  const el = span("sftp-queue-name");
  el.textContent = name;
  el.title = name;
  return el;
}

function progressNodes(item: TransferItem): Node[] {
  const track = span("sftp-queue-track");
  const fill = span("sftp-queue-fill");
  fill.style.width = `${percentOf(item)}%`;
  track.appendChild(fill);
  const pct = span("sftp-queue-pct");
  pct.textContent = progressText(item);
  return [track, pct];
}

function percentOf(item: TransferItem): number {
  if (item.total <= 0) return 0;
  return Math.min(100, Math.round((item.transferred / item.total) * 100));
}

/** A percentage, or the bytes so far while the total is unknown. */
function progressText(item: TransferItem): string {
  return item.total > 0 ? `${percentOf(item)}%` : formatSize(item.transferred);
}

function span(className: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = className;
  return el;
}
