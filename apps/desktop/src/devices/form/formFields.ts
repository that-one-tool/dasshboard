/** Small read/write helpers over the device dialog's inputs. Readers use
 * `requireEl`: a missing input means markup and code drifted. Writers skip a
 * missing input. */

import { requireEl } from "../../ui/dom";

/** Trim a text input; an empty result becomes `null` (⇒ "unset" on the wire). */
export function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function inputValue(form: ParentNode, selector: string): string {
  return requireEl<HTMLInputElement>(form, selector).value;
}

export function inputInt(form: ParentNode, selector: string): number {
  return parseInt(inputValue(form, selector), 10);
}

export function inputChecked(form: ParentNode, selector: string): boolean {
  return requireEl<HTMLInputElement>(form, selector).checked;
}

/** Sets an input's (or select's / textarea's) value; `null`/`undefined` → "". */
export function setInputValue(root: ParentNode, selector: string, value: unknown): void {
  const input = root.querySelector<HTMLInputElement>(selector);
  if (input) input.value = String(value ?? "");
}

export function setChecked(root: ParentNode, selector: string, checked: boolean | undefined): void {
  const input = root.querySelector<HTMLInputElement>(selector);
  if (input) input.checked = checked ?? false;
}
