/**
 * Shared promise-based modal helpers, reusing the app's `.dialog` styling
 * (Phase 6 consistency pass). Before this, four near-identical copies of these
 * dialogs had accreted across phases — a `confirm` in `grid.ts`, another in
 * `profileManager.ts`, a `prompt` in `profileManager.ts`, and a raw native
 * `window.confirm()` in `deviceManager.ts`. They are now unified here so every
 * confirm/prompt looks and behaves the same: Escape cancels, Enter accepts,
 * focus lands inside the dialog on open and is restored to the trigger on close.
 * The shared lifecycle lives in `modalDialog.ts`.
 *
 * `confirm` resolves `true` on accept, `false` on cancel / overlay click /
 * Escape. `prompt` resolves the entered string on OK / Enter, or `null` on
 * cancel / overlay click / Escape.
 */

import { t } from "../i18n";
import { cancelOnEscape, createDialogRoot, focusAction, setText, showModal } from "./modalDialog";

export { choosePermissions } from "./permissionsDialog";

export interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the accept button as destructive (red) — deletes, session teardown. */
  danger?: boolean;
  /** Show the message's `\n`s as line breaks. Only for messages that keep
   * untrusted text (names) on one line, or a newline in it could fake one. */
  keepLineBreaks?: boolean;
}

interface ChoiceButton {
  action: string;
  style: string;
  label: string;
}

export function confirm(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  const root = createChoiceDialog(options.title ?? t("confirm.title"), message, confirmButtons(options));
  keepLineBreaks(root, !!options.keepLineBreaks);
  return showModal(root, {
    cancelValue: false,
    actions: { confirm: () => true },
    keyResult: (e) => confirmKeyResult(e.key, root),
    focus: focusAction("confirm"),
  });
}

function confirmButtons(options: ConfirmOptions): ChoiceButton[] {
  return [
    { action: "cancel", style: "btn-secondary", label: options.cancelLabel ?? t("common.cancel") },
    { action: "confirm", style: confirmStyle(options), label: options.confirmLabel ?? t("common.continue") },
  ];
}

function keepLineBreaks(root: HTMLElement, keep: boolean): void {
  root.querySelector(".confirm-message")?.classList.toggle("confirm-lines", keep);
}

function confirmStyle(options: ConfirmOptions): string {
  return options.danger ? "btn-danger" : "btn-primary";
}

export function prompt(title: string, placeholder: string, initial = ""): Promise<string | null> {
  const root = createDialogRoot("prompt-dialog", promptHtml());
  setText(root, ".prompt-title", title);
  const input = root.querySelector<HTMLInputElement>(".prompt-input");
  fillInput(input, placeholder, initial);
  const value = (): string => input?.value ?? "";
  return showModal<string | null>(root, {
    cancelValue: null,
    actions: { ok: value },
    keyResult: (e) => PROMPT_KEYS.get(e.key)?.(root, value),
    focus: () => focusAndSelect(input),
  });
}

/** Prompt keys: Escape cancels; Enter accepts, unless Cancel has focus. */
const PROMPT_KEYS = new Map<string, (root: HTMLElement, value: () => string) => string | null>([
  ["Enter", (root, value) => (cancelHasFocus(root) ? null : value())],
  ["Escape", () => null],
]);

function cancelHasFocus(root: HTMLElement): boolean {
  const focused = document.activeElement;
  return focused instanceof HTMLElement && root.contains(focused) && focused.dataset.action === "cancel";
}

function promptHtml(): string {
  return `
      <div class="dialog-overlay"></div>
      <div class="dialog-content prompt-content">
        <div class="dialog-header"><h2 class="prompt-title"></h2></div>
        <input type="text" class="prompt-input" />
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" data-action="cancel">${t("common.cancel")}</button>
          <button type="button" class="btn btn-primary" data-action="ok">${t("common.ok")}</button>
        </div>
      </div>
    `;
}

function fillInput(input: HTMLInputElement | null, placeholder: string, initial: string): void {
  if (!input) return;
  input.placeholder = placeholder;
  input.value = initial;
}

function focusAndSelect(input: HTMLInputElement | null): void {
  input?.focus();
  input?.select();
}

/** The conflict resolutions a folder transfer can take, or `null` on cancel. */
export type ConflictChoice = "overwrite" | "skip" | "rename";

/**
 * A three-way conflict dialog for a recursive transfer whose destination already
 * exists: Overwrite / Skip existing / Keep both (rename), plus Cancel. Resolves
 * the chosen policy, or `null` on cancel / overlay / Escape. One choice applies
 * to the whole operation.
 */
export function chooseConflict(message: string): Promise<ConflictChoice | null> {
  const root = createChoiceDialog(t("sftp.conflict.title"), message, [
    { action: "cancel", style: "btn-secondary", label: t("common.cancel") },
    { action: "skip", style: "btn-secondary", label: t("sftp.conflict.skip") },
    { action: "rename", style: "btn-secondary", label: t("sftp.conflict.rename") },
    { action: "overwrite", style: "btn-primary", label: t("sftp.conflict.overwrite") },
  ]);
  return showModal<ConflictChoice | null>(root, {
    cancelValue: null,
    actions: { overwrite: () => "overwrite", skip: () => "skip", rename: () => "rename" },
    keyResult: cancelOnEscape(null),
    focus: focusAction("overwrite"),
  });
}

/** How to resolve an edited file that also changed on the server. */
export type EditConflictChoice = "overwrite" | "discard";

/**
 * The edit-in-place conflict dialog: overwrite the server copy with the saved
 * edit, discard the edit (re-download), or decide later (`null`, also on
 * overlay / Escape). Focus starts on "later", and Enter is not a shortcut, so
 * a stray keypress never picks one of the two destructive choices.
 */
export function chooseEditConflict(name: string): Promise<EditConflictChoice | null> {
  const root = createChoiceDialog(t("sftp.edit.conflict.title"), t("sftp.edit.conflict.message", { name }), [
    { action: "cancel", style: "btn-secondary", label: t("sftp.edit.conflict.later") },
    { action: "discard", style: "btn-danger", label: t("sftp.edit.conflict.discard") },
    { action: "overwrite", style: "btn-primary", label: t("sftp.edit.conflict.overwrite") },
  ]);
  return showModal<EditConflictChoice | null>(root, {
    cancelValue: null,
    actions: { overwrite: () => "overwrite", discard: () => "discard" },
    keyResult: cancelOnEscape(null),
    focus: focusAction("cancel"),
  });
}

/** A titled message with a row of buttons; all text goes in as text, not markup. */
function createChoiceDialog(title: string, message: string, buttons: ChoiceButton[]): HTMLElement {
  const root = createDialogRoot("confirm-dialog", CHOICE_HTML);
  setText(root, ".confirm-title", title);
  setText(root, ".confirm-message", message);
  root.querySelector(".form-actions")?.append(...buttons.map(createChoiceButton));
  return root;
}

const CHOICE_HTML = `
      <div class="dialog-overlay"></div>
      <div class="dialog-content confirm-content">
        <div class="dialog-header"><h2 class="confirm-title"></h2></div>
        <p class="confirm-message"></p>
        <div class="form-actions"></div>
      </div>
    `;

function createChoiceButton({ action, style, label }: ChoiceButton): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `btn ${style}`;
  button.dataset.action = action;
  button.textContent = label;
  return button;
}

/** What a key does in a confirm: `false` = cancel (Escape), `true` = accept,
 * `undefined` = nothing. */
function confirmKeyResult(key: string, root: HTMLElement): boolean | undefined {
  if (key === "Escape") return false;
  if (key === "Enter") return enterAccepts(root);
  return undefined;
}

/** Enter answers as the focused dialog button would — Enter on Cancel cancels —
 * and accepts when focus is elsewhere (e.g. fell back to the body). */
function enterAccepts(root: HTMLElement): boolean {
  const focused = document.activeElement;
  const onButton = focused instanceof HTMLButtonElement && root.contains(focused);
  return !onButton || focused.dataset.action === "confirm";
}
