/**
 * The Files panel's checkbox selection: entry names (directory-relative) plus
 * the anchor a shift-click extends a range from.
 */

import type { SftpEntry } from "../../ipc";

export class EntrySelection {
  private selected = new Set<string>();
  /** Index of the last toggled row, or -1. */
  private anchor = -1;

  get size(): number {
    return this.selected.size;
  }

  has(name: string): boolean {
    return this.selected.has(name);
  }

  names(): string[] {
    return [...this.selected];
  }

  selectedIn(entries: readonly SftpEntry[]): SftpEntry[] {
    return entries.filter((e) => this.selected.has(e.name));
  }

  allSelected(entries: readonly SftpEntry[]): boolean {
    return entries.length > 0 && this.selected.size === entries.length;
  }

  /** Toggle one row; with `shift`, select the rows from the anchor to it. */
  toggle(entries: readonly SftpEntry[], index: number, shift: boolean): void {
    if (this.extendsRange(shift)) this.selectRange(entries, this.anchor, index);
    else this.toggleName(entries[index]?.name);
    this.anchor = index;
  }

  toggleAll(entries: readonly SftpEntry[]): void {
    const all = this.allSelected(entries);
    this.clear();
    if (!all) entries.forEach((e) => this.selected.add(e.name));
  }

  clear(): void {
    this.selected.clear();
    this.anchor = -1;
  }

  /** Rows were reordered: the anchor's index no longer means the same row. */
  forgetAnchor(): void {
    this.anchor = -1;
  }

  private extendsRange(shift: boolean): boolean {
    return shift && this.anchor >= 0;
  }

  private selectRange(entries: readonly SftpEntry[], from: number, to: number): void {
    const first = Math.min(from, to);
    const last = Math.max(from, to);
    entries.slice(first, last + 1).forEach((e) => this.selected.add(e.name));
  }

  private toggleName(name: string | undefined): void {
    if (!name) return;
    if (!this.selected.delete(name)) this.selected.add(name);
  }
}
