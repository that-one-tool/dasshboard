/**
 * The "Port forwarding" editor embedded in the SSH device dialog (SPEC tunnels
 * §6). Renders a dynamic list of forward rows into a host container and reads
 * them back on save. Kept as a small self-contained controller so the device
 * dialog stays thin glue; validation reuses the pure `forwardValidation` rules.
 *
 * The DOM is the source of truth: `getForwards` reads the current inputs, so
 * add/remove and edits need no parallel data model. Each row carries its stable
 * forward `id` (preserved across edits) as a data attribute.
 */

import type { Forward } from "../ipc";
import { validateForwards } from "./forwardValidation";
import { t } from "../i18n";

const DEFAULT_LOCAL_ADDR = "127.0.0.1";

/** A unique id for a newly-added forward. UUID when available, else a fallback. */
function newForwardId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `fwd-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  }
}

export class ForwardsEditor {
  private readonly rowsEl: HTMLElement;

  constructor(private readonly container: HTMLElement) {
    this.container.innerHTML = `
      <div class="forwards-header">
        <span class="forwards-title">${t("forwards.title")}</span>
        <button type="button" class="btn btn-secondary forwards-add">${t("forwards.add")}</button>
      </div>
      <div class="forwards-rows"></div>
    `;
    this.rowsEl = this.requireEl(".forwards-rows");
    this.requireEl(".forwards-add").addEventListener("click", () => {
      this.addRow();
    });
  }

  /** Replace the rows with the given forwards (edit) or clear them (`[]`). */
  setForwards(forwards: Forward[]): void {
    this.rowsEl.innerHTML = "";
    forwards.forEach((forward) => this.addRow(forward));
  }

  /**
   * Read the current rows as `Forward[]`. A blank local address defaults to
   * loopback (so a saved forward always carries a bindable address). Intended to
   * be called after {@link validate} has passed, so ports are real numbers.
   */
  getForwards(): Forward[] {
    return this.rowRects().map((row) => ({
      id: row.dataset.forwardId ?? newForwardId(),
      name: this.inputValue(row, ".forward-name"),
      localAddr: this.inputValue(row, ".forward-local-addr") || DEFAULT_LOCAL_ADDR,
      localPort: this.portValue(row, ".forward-local-port"),
      remoteHost: this.inputValue(row, ".forward-remote-host"),
      remotePort: this.portValue(row, ".forward-remote-port"),
    }));
  }

  /**
   * Validate the rows against the backend rules, rendering the first error on
   * each offending row. Returns `true` when every forward is valid.
   */
  validate(): boolean {
    const rows = this.rowRects();
    rows.forEach((row) => this.setRowError(row, ""));
    const errors = validateForwards(this.getForwards());
    for (const { field, message } of errors) {
      const index = this.rowIndexOf(field);
      const row = index === null ? undefined : rows[index];
      if (row && this.rowError(row) === "") {
        this.setRowError(row, message);
      }
    }
    return errors.length === 0;
  }

  private addRow(forward?: Forward): void {
    const row = document.createElement("div");
    row.className = "forward-row";
    row.dataset.forwardId = forward?.id ?? newForwardId();
    row.innerHTML = `
      <input class="forward-name" type="text" placeholder="${t("forwards.name.placeholder")}" autocomplete="off" />
      <input class="forward-local-addr" type="text" placeholder="127.0.0.1" autocomplete="off" />
      <input class="forward-local-port" type="number" placeholder="${t("forwards.localPort.placeholder")}" min="1" max="65535" />
      <span class="forward-arrow" aria-hidden="true">&rarr;</span>
      <input class="forward-remote-host" type="text" placeholder="${t("forwards.remoteHost.placeholder")}" autocomplete="off" />
      <input class="forward-remote-port" type="number" placeholder="${t("forwards.remotePort.placeholder")}" min="1" max="65535" />
      <button type="button" class="forward-remove" title="${t("forwards.remove")}" aria-label="${t("forwards.remove")}">&times;</button>
      <span class="error-text"></span>
    `;
    // Values are set programmatically (never interpolated into HTML) so
    // user/stored strings can't break out of an attribute.
    this.setInput(row, ".forward-name", forward?.name ?? "");
    this.setInput(row, ".forward-local-addr", forward?.localAddr ?? DEFAULT_LOCAL_ADDR);
    this.setInput(row, ".forward-local-port", forward ? String(forward.localPort) : "");
    this.setInput(row, ".forward-remote-host", forward?.remoteHost ?? "");
    this.setInput(row, ".forward-remote-port", forward ? String(forward.remotePort) : "");
    row
      .querySelector(".forward-remove")
      ?.addEventListener("click", () => row.remove());
    this.rowsEl.appendChild(row);
  }

  private rowRects(): HTMLElement[] {
    return Array.from(this.rowsEl.querySelectorAll<HTMLElement>(".forward-row"));
  }

  /** Map a `forward-<index>-<field>` error field to its row index. */
  private rowIndexOf(field: string): number | null {
    const match = /^forward-(\d+)-/.exec(field);
    return match ? Number(match[1]) : null;
  }

  private inputValue(row: HTMLElement, selector: string): string {
    return row.querySelector<HTMLInputElement>(selector)?.value.trim() ?? "";
  }

  private portValue(row: HTMLElement, selector: string): number {
    return parseInt(
      row.querySelector<HTMLInputElement>(selector)?.value ?? "",
      10,
    );
  }

  private setInput(row: HTMLElement, selector: string, value: string): void {
    const input = row.querySelector<HTMLInputElement>(selector);
    if (input) input.value = value;
  }

  private setRowError(row: HTMLElement, message: string): void {
    const el = row.querySelector(".error-text");
    if (el) el.textContent = message;
  }

  private rowError(row: HTMLElement): string {
    return row.querySelector(".error-text")?.textContent ?? "";
  }

  private requireEl(selector: string): HTMLElement {
    const el = this.container.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`ForwardsEditor: element not found: ${selector}`);
    return el;
  }
}
