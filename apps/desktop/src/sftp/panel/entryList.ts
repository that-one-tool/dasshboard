/** The Files panel's listing: the rendered rows, their checkbox selection and
 * the bulk bar that acts on it. */

import type { SftpEntry } from "../../ipc";
import { t, tp } from "../../i18n";
import { renderEntryRow, type EntryRowActions } from "./entryRow";
import { EntrySelection } from "./entrySelection";
import type { PanelElements } from "./panelElements";

export interface EntryListDeps {
  els: () => PanelElements;
  rowActions: EntryRowActions;
  /** Whether the bulk bar offers Paste (a cut is pending for elsewhere). */
  canPaste: () => boolean;
}

export class EntryList {
  /** The checked entries; cleared on navigation. */
  readonly selection = new EntrySelection();
  /** The entries currently rendered, in DOM order (for select-all, shift-range
   * and kind lookup). */
  private entries: SftpEntry[] = [];

  constructor(private readonly deps: EntryListDeps) {}

  names(): string[] {
    return this.entries.map((entry) => entry.name);
  }

  /** The selected entries, resolved against the rendered listing. */
  selected(): SftpEntry[] {
    return this.selection.selectedIn(this.entries);
  }

  render(entries: SftpEntry[]): void {
    const { list, bulkBar } = this.deps.els();
    this.entries = entries;
    bulkBar.hidden = false;
    list.replaceChildren(...this.rows(entries));
    this.updateBulkBar();
  }

  /** The entry area of a not-connected panel: just `message`. */
  renderDisconnected(message: string): void {
    this.renderNotice(disconnectedNotice(message));
  }

  private renderNotice(notice: HTMLElement): void {
    const { list, bulkBar } = this.deps.els();
    this.selection.clear();
    this.entries = [];
    bulkBar.hidden = true;
    list.replaceChildren(notice);
  }

  /** The entry area while a connect is in flight: a spinner and `message`. */
  renderConnecting(message: string): void {
    this.renderNotice(connectingNotice(message));
  }

  isConnecting(): boolean {
    return this.deps.els().list.querySelector(".sftp-connecting") !== null;
  }

  /** The entry area with just `message`, no rows. */
  renderMessage(message: string): void {
    this.renderNotice(emptyNotice(message));
  }

  /** Toggle one row's checkbox; with `shift`, select the range from the last
   * toggled row (inclusive) to this one. */
  toggleCheck(index: number, shift: boolean): void {
    this.selection.toggle(this.entries, index, shift);
    this.syncSelection();
  }

  /** Select every entry when not all are selected, else clear (the header box). */
  toggleAll(): void {
    this.selection.toggleAll(this.entries);
    this.syncSelection();
  }

  clearSelection(): void {
    this.selection.clear();
    this.syncSelection();
  }

  /** Reflect selection count + clipboard onto the bulk bar (count, enabled
   * actions, Paste visibility). */
  updateBulkBar(): void {
    const els = this.deps.els();
    const count = this.selection.size;
    els.selCount.textContent = count > 0 ? tp("sftp.selected", count) : t("sftp.selectAll");
    this.syncSelectAll(els.selectAll, count);
    enableBulkActions(els.bulkBar, count > 0);
    showPaste(els.pasteBtn, this.deps.canPaste());
  }

  /** Clear the JS hover flag from every row. Called before opening a dialog so
   * the action buttons don't stay visible while a native dialog (which
   * suppresses `mouseleave`) is up. */
  clearHover(): void {
    this.deps.els().list.querySelectorAll(".sftp-entry.hovering").forEach((row) => row.classList.remove("hovering"));
  }

  private rows(entries: SftpEntry[]): HTMLElement[] {
    if (entries.length === 0) return [emptyNotice(t("sftp.emptyDir"))];
    return entries.map((entry, index) =>
      renderEntryRow(entry, index, this.selection.has(entry.name), this.deps.rowActions),
    );
  }

  /** Push the selection state onto the row checkboxes + the bulk bar. */
  private syncSelection(): void {
    const rows = this.deps.els().list.querySelectorAll<HTMLElement>(".sftp-entry");
    rows.forEach((row, index) => setRowChecked(row, this.isSelectedAt(index)));
    this.updateBulkBar();
  }

  private isSelectedAt(index: number): boolean {
    return this.selection.has(this.entries[index]?.name ?? "");
  }

  private syncSelectAll(box: HTMLInputElement, count: number): void {
    box.checked = this.selection.allSelected(this.entries);
    box.indeterminate = count > 0 && count < this.entries.length;
  }
}

function setRowChecked(row: HTMLElement, checked: boolean): void {
  const check = row.querySelector<HTMLInputElement>(".sftp-entry-check");
  if (check) check.checked = checked;
}

function enableBulkActions(bulkBar: HTMLElement, enabled: boolean): void {
  bulkBar.querySelectorAll<HTMLButtonElement>('[data-action^="bulk-"]:not(.sftp-bulk-paste)').forEach((btn) => {
    btn.disabled = !enabled;
  });
}

function showPaste(btn: HTMLButtonElement, canPaste: boolean): void {
  btn.hidden = !canPaste;
  btn.disabled = !canPaste;
}

function emptyNotice(message: string): HTMLElement {
  const empty = document.createElement("p");
  empty.className = "sftp-empty";
  empty.textContent = message;
  return empty;
}

function connectingNotice(message: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "sftp-connecting";
  const spinner = document.createElement("span");
  spinner.className = "sftp-spinner";
  spinner.setAttribute("aria-hidden", "true");
  wrap.append(spinner, emptyNotice(message));
  return wrap;
}

function disconnectedNotice(message: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "sftp-disconnected";
  wrap.appendChild(emptyNotice(message));
  return wrap;
}
