/**
 * Inline-renames a tab: swaps its name label for a text input (double-click).
 * Enter / blur commits a non-empty trimmed value; Escape cancels. Pointer
 * events inside the input are stopped so they don't re-activate or close the
 * tab underneath.
 */

import { t } from "../i18n";

/** Enter commits, Escape cancels. */
const RENAME_KEYS = new Map([
  ["Enter", true],
  ["Escape", false],
]);

/** Starts renaming `button`'s tab, named `name`; `onRename` gets a changed,
 * non-empty name once committed. A no-op while already renaming. */
export function startRename(button: HTMLElement, name: string, onRename: (next: string) => void): void {
  const nameEl = button.querySelector<HTMLElement>(".tab-name");
  if (!nameEl || button.querySelector(".tab-rename-input")) return;
  const input = createRenameInput(name);
  nameEl.hidden = true;
  nameEl.after(input);
  input.focus();
  input.select();
  wireRename(input, nameEl, (next) => commitRename(next, nameEl, name, onRename));
}

function createRenameInput(name: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "tab-rename-input";
  input.value = name;
  input.setAttribute("aria-label", t("tabs.rename"));
  for (const type of ["mousedown", "click", "dblclick"] as const) {
    input.addEventListener(type, (e) => e.stopPropagation());
  }
  return input;
}

/** Ends the rename once (Enter, Escape or blur), committing unless cancelled. */
function wireRename(input: HTMLInputElement, nameEl: HTMLElement, commit: (next: string) => void): void {
  let done = false;
  const finish = (commits: boolean): void => {
    if (done) return;
    done = true;
    if (commits) commit(input.value.trim());
    input.remove();
    nameEl.hidden = false;
  };
  input.addEventListener("keydown", (e) => {
    const commits = RENAME_KEYS.get(e.key);
    if (commits === undefined) return;
    e.preventDefault();
    finish(commits);
  });
  input.addEventListener("blur", () => finish(true));
}

function commitRename(next: string, nameEl: HTMLElement, name: string, onRename: (next: string) => void): void {
  if (!next || next === name) return;
  nameEl.textContent = next;
  onRename(next);
}
