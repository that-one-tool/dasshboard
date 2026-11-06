/** The command editor: name, command text, and whether it runs (Enter after
 * each line) or is only typed in. Resolves the edited copy, or null. */

import type { SavedCommand } from "../ipc";
import { t } from "../i18n";
import { requireEl } from "../ui/dom";
import { consumeKey, isTopDialog, pushDialog, removeDialog } from "../ui/dialogStack";
import { findCommandProblem } from "./commandText";

interface CommandDialogView {
  root: HTMLElement;
  name: HTMLInputElement;
  text: HTMLTextAreaElement;
  run: HTMLInputElement;
  error: HTMLElement;
}

interface DialogActions {
  save(): void;
  cancel(): void;
}

export function openCommandDialog(initial: SavedCommand): Promise<SavedCommand | null> {
  return new Promise((resolve) => {
    const view = buildView(initial);
    const previouslyFocused = document.activeElement;
    const finish = (result: SavedCommand | null): void => {
      document.removeEventListener("keydown", onKey, true);
      removeDialog(view.root);
      view.root.remove();
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
      resolve(result);
    };
    const actions: DialogActions = { save: () => trySave(view, initial, finish), cancel: () => finish(null) };
    const onKey = (e: KeyboardEvent): void => runKeyAction(e, keyAction(e, view, actions));
    view.root.addEventListener("click", (e) => clickAction(e.target, actions)?.());
    document.addEventListener("keydown", onKey, true);
    pushDialog(view.root);
    view.name.focus();
  });
}

function trySave(view: CommandDialogView, initial: SavedCommand, finish: (c: SavedCommand) => void): void {
  const draft = { ...initial, name: view.name.value, text: view.text.value, run: view.run.checked };
  const problem = findCommandProblem(draft);
  if (problem) view.error.textContent = t(`commands.problem.${problem}`);
  else finish(draft);
}

/** Escape cancels; Enter saves, except in the command, where it adds a line. */
function keyAction(e: KeyboardEvent, view: CommandDialogView, actions: DialogActions): (() => void) | undefined {
  if (!isTopDialog(view.root)) return undefined;
  const enterSaves = isPlainField(e.target, view);
  return { Escape: actions.cancel, Enter: enterSaves ? actions.save : undefined }[e.key];
}

/** Enter adds a line in the command, and does what a focused button does. */
function isPlainField(target: EventTarget | null, view: CommandDialogView): boolean {
  return target !== view.text && !(target instanceof HTMLButtonElement);
}

function runKeyAction(e: KeyboardEvent, action: (() => void) | undefined): void {
  if (!action) return;
  consumeKey(e);
  action();
}

function clickAction(target: EventTarget | null, actions: DialogActions): (() => void) | undefined {
  if (!(target instanceof HTMLElement)) return undefined;
  return actions[target.dataset.action as keyof DialogActions];
}

function buildView(initial: SavedCommand): CommandDialogView {
  const root = document.createElement("div");
  root.className = "dialog command-dialog";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.innerHTML = dialogMarkup(initial.id === "");
  document.body.appendChild(root);
  const view: CommandDialogView = {
    root,
    name: requireEl<HTMLInputElement>(root, ".command-name-input"),
    text: requireEl<HTMLTextAreaElement>(root, ".command-text-input"),
    run: requireEl<HTMLInputElement>(root, ".command-run-input"),
    error: requireEl<HTMLElement>(root, ".command-dialog-error"),
  };
  view.name.value = initial.name;
  view.text.value = initial.text;
  view.run.checked = initial.run;
  return view;
}

function dialogMarkup(isNew: boolean): string {
  return `
    <div class="dialog-overlay" data-action="cancel"></div>
    <div class="dialog-content command-dialog-content">
      <div class="dialog-header">
        <h2 class="command-dialog-title">${t(isNew ? "commands.dialog.newTitle" : "commands.dialog.editTitle")}</h2>
      </div>
      <div class="command-dialog-body">${fieldsMarkup()}</div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-action="cancel">${t("common.cancel")}</button>
        <button type="button" class="btn btn-primary" data-action="save">${t("common.save")}</button>
      </div>
    </div>
  `;
}

function fieldsMarkup(): string {
  return `
    <div class="form-group">
      <label for="command-name">${t("commands.dialog.name")}</label>
      <input id="command-name" type="text" class="command-name-input" autocomplete="off" spellcheck="false" />
    </div>
    <div class="form-group">
      <label for="command-text">${t("commands.dialog.text")}</label>
      <textarea id="command-text" class="command-text-input" rows="4" autocomplete="off" spellcheck="false"></textarea>
    </div>
    <div class="form-group form-group-checkbox">
      <label for="command-run"><input id="command-run" type="checkbox" class="command-run-input" />
        ${t("commands.dialog.run")}</label>
    </div>
    <span class="error-text command-dialog-error" role="alert"></span>
  `;
}
