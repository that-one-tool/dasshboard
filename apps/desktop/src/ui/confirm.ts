/**
 * Shared promise-based modal helpers, reusing the app's `.dialog` styling
 * (Phase 6 consistency pass). Before this, four near-identical copies of these
 * dialogs had accreted across phases — a `confirm` in `grid.ts`, another in
 * `profileManager.ts`, a `prompt` in `profileManager.ts`, and a raw native
 * `window.confirm()` in `deviceManager.ts`. They are now unified here so every
 * confirm/prompt looks and behaves the same: Escape cancels, Enter accepts,
 * focus lands inside the dialog on open and is restored to the trigger on close.
 *
 * `confirm` resolves `true` on accept, `false` on cancel / overlay click /
 * Escape. `prompt` resolves the entered string on OK / Enter, or `null` on
 * cancel / overlay click / Escape.
 */

import { t } from "../i18n";
import { consumeKey, isTopDialog, pushDialog, removeDialog } from "./dialogStack";

export interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the accept button as destructive (red) — deletes, session teardown. */
  danger?: boolean;
}

export function confirm(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  const title = options.title ?? t("confirm.title");
  const confirmLabel = options.confirmLabel ?? t("common.continue");
  const cancelLabel = options.cancelLabel ?? t("common.cancel");
  const confirmClass = options.danger ? "btn-danger" : "btn-primary";

  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.className = "dialog confirm-dialog";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.innerHTML = `
      <div class="dialog-overlay"></div>
      <div class="dialog-content confirm-content">
        <div class="dialog-header"><h2 class="confirm-title"></h2></div>
        <p class="confirm-message"></p>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" data-action="cancel"></button>
          <button type="button" class="btn ${confirmClass}" data-action="confirm"></button>
        </div>
      </div>
    `;
    const set = (sel: string, text: string): void => {
      const el = root.querySelector(sel);
      if (el) el.textContent = text;
    };
    set(".confirm-title", title);
    set(".confirm-message", message);
    set('[data-action="cancel"]', cancelLabel);
    set('[data-action="confirm"]', confirmLabel);

    const previouslyFocused = document.activeElement;
    const finish = (result: boolean): void => {
      document.removeEventListener("keydown", onKey, true);
      removeDialog(root);
      root.remove();
      restoreFocus(previouslyFocused);
      resolve(result);
    };
    root.addEventListener("click", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const action = target.dataset.action;
      if (action === "confirm") finish(true);
      else if (action === "cancel" || target.classList.contains("dialog-overlay")) finish(false);
    });
    const onKey = (e: KeyboardEvent): void => {
      const result = isTopDialog(root) ? confirmKeyResult(e.key, root) : undefined;
      if (result === undefined) return;
      consumeKey(e);
      finish(result);
    };
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(root);
    pushDialog(root);
    root.querySelector<HTMLButtonElement>('[data-action="confirm"]')?.focus();
  });
}

export function prompt(
  title: string,
  placeholder: string,
  initial = "",
): Promise<string | null> {
  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.className = "dialog prompt-dialog";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.innerHTML = `
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
    const titleEl = root.querySelector<HTMLElement>(".prompt-title");
    if (titleEl) titleEl.textContent = title;
    const input = root.querySelector<HTMLInputElement>(".prompt-input");
    if (input) {
      input.placeholder = placeholder;
      input.value = initial;
    }

    const previouslyFocused = document.activeElement;
    const finish = (result: string | null): void => {
      removeDialog(root);
      root.remove();
      restoreFocus(previouslyFocused);
      resolve(result);
    };
    root.addEventListener("click", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const action = target.dataset.action;
      if (action === "ok") finish(input?.value ?? "");
      else if (action === "cancel" || target.classList.contains("dialog-overlay")) finish(null);
    });
    root.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(input?.value ?? "");
      else if (e.key === "Escape") finish(null);
    });
    document.body.appendChild(root);
    pushDialog(root);
    input?.focus();
    input?.select();
  });
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
  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.className = "dialog confirm-dialog";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.innerHTML = `
      <div class="dialog-overlay"></div>
      <div class="dialog-content confirm-content">
        <div class="dialog-header"><h2 class="confirm-title"></h2></div>
        <p class="confirm-message"></p>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" data-action="cancel"></button>
          <button type="button" class="btn btn-secondary" data-action="skip"></button>
          <button type="button" class="btn btn-secondary" data-action="rename"></button>
          <button type="button" class="btn btn-primary" data-action="overwrite"></button>
        </div>
      </div>
    `;
    const set = (sel: string, text: string): void => {
      const el = root.querySelector(sel);
      if (el) el.textContent = text;
    };
    set(".confirm-title", t("sftp.conflict.title"));
    set(".confirm-message", message);
    set('[data-action="cancel"]', t("common.cancel"));
    set('[data-action="skip"]', t("sftp.conflict.skip"));
    set('[data-action="rename"]', t("sftp.conflict.rename"));
    set('[data-action="overwrite"]', t("sftp.conflict.overwrite"));

    const previouslyFocused = document.activeElement;
    const finish = (result: ConflictChoice | null): void => {
      document.removeEventListener("keydown", onKey, true);
      removeDialog(root);
      root.remove();
      restoreFocus(previouslyFocused);
      resolve(result);
    };
    root.addEventListener("click", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const action = target.dataset.action;
      if (action === "overwrite" || action === "skip" || action === "rename") finish(action);
      else if (action === "cancel" || target.classList.contains("dialog-overlay")) finish(null);
    });
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && isTopDialog(root)) {
        consumeKey(e);
        finish(null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(root);
    pushDialog(root);
    root.querySelector<HTMLButtonElement>('[data-action="overwrite"]')?.focus();
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
  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.className = "dialog confirm-dialog";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.innerHTML = `
      <div class="dialog-overlay"></div>
      <div class="dialog-content confirm-content">
        <div class="dialog-header"><h2 class="confirm-title"></h2></div>
        <p class="confirm-message"></p>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" data-action="cancel"></button>
          <button type="button" class="btn btn-danger" data-action="discard"></button>
          <button type="button" class="btn btn-primary" data-action="overwrite"></button>
        </div>
      </div>
    `;
    const set = (sel: string, text: string): void => {
      const el = root.querySelector(sel);
      if (el) el.textContent = text;
    };
    set(".confirm-title", t("sftp.edit.conflict.title"));
    set(".confirm-message", t("sftp.edit.conflict.message", { name }));
    set('[data-action="cancel"]', t("sftp.edit.conflict.later"));
    set('[data-action="discard"]', t("sftp.edit.conflict.discard"));
    set('[data-action="overwrite"]', t("sftp.edit.conflict.overwrite"));

    const previouslyFocused = document.activeElement;
    const finish = (result: EditConflictChoice | null): void => {
      document.removeEventListener("keydown", onKey, true);
      removeDialog(root);
      root.remove();
      restoreFocus(previouslyFocused);
      resolve(result);
    };
    root.addEventListener("click", (e) => {
      const choice = editConflictChoiceOf(e.target);
      if (choice !== undefined) finish(choice);
    });
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && isTopDialog(root)) {
        consumeKey(e);
        finish(null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(root);
    pushDialog(root);
    root.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.focus();
  });
}

const EDIT_CONFLICT_ACTIONS: Record<string, EditConflictChoice | null> = {
  overwrite: "overwrite",
  discard: "discard",
  cancel: null,
};

/** The edit-conflict choice a click picks (`null` = later, including the
 * overlay), or `undefined` for a click elsewhere in the dialog. */
function editConflictChoiceOf(target: EventTarget | null): EditConflictChoice | null | undefined {
  if (!(target instanceof HTMLElement)) return undefined;
  if (target.classList.contains("dialog-overlay")) return null;
  return EDIT_CONFLICT_ACTIONS[String(target.dataset.action)];
}

/**
 * A chmod dialog: a 3×3 grid of read/write/execute checkboxes for
 * owner/group/other, prefilled from `mode`, with a live octal readout. Resolves
 * the new mode (the edited rwx bits merged with the original's special bits, so
 * setuid/setgid/sticky are preserved), or `null` on cancel / overlay / Escape.
 */
export function choosePermissions(name: string, mode: number): Promise<number | null> {
  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.className = "dialog perms-dialog";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.innerHTML = `
      <div class="dialog-overlay"></div>
      <div class="dialog-content perms-content">
        <div class="dialog-header"><h2 class="perms-title"></h2></div>
        <p class="perms-name"></p>
        <table class="perms-grid">
          <thead>
            <tr>
              <th></th>
              <th>${t("sftp.perms.read")}</th>
              <th>${t("sftp.perms.write")}</th>
              <th>${t("sftp.perms.exec")}</th>
            </tr>
          </thead>
          <tbody class="perms-body"></tbody>
        </table>
        <p class="perms-octal" aria-live="polite"></p>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" data-action="cancel">${t("common.cancel")}</button>
          <button type="button" class="btn btn-primary" data-action="ok">${t("common.ok")}</button>
        </div>
      </div>
    `;
    const titleEl = root.querySelector<HTMLElement>(".perms-title");
    if (titleEl) titleEl.textContent = t("sftp.perms.title");
    const nameEl = root.querySelector<HTMLElement>(".perms-name");
    if (nameEl) nameEl.textContent = name;

    // Build owner/group/other rows (shift 6/3/0), each with r/w/x checkboxes.
    const classes: { label: string; shift: number }[] = [
      { label: t("sftp.perms.owner"), shift: 6 },
      { label: t("sftp.perms.group"), shift: 3 },
      { label: t("sftp.perms.other"), shift: 0 },
    ];
    const body = root.querySelector(".perms-body");
    for (const { label, shift } of classes) {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.scope = "row";
      th.textContent = label;
      tr.appendChild(th);
      for (const bit of [4, 2, 1]) {
        const td = document.createElement("td");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = ((mode >> shift) & bit) !== 0;
        cb.dataset.value = String(bit << shift);
        cb.setAttribute("aria-label", `${label} ${bit === 4 ? "r" : bit === 2 ? "w" : "x"}`);
        td.appendChild(cb);
        tr.appendChild(td);
      }
      body?.appendChild(tr);
    }

    const octalEl = root.querySelector<HTMLElement>(".perms-octal");
    // The edited rwx bits (0o777) merged with the original special bits (0o7000).
    const readMode = (): number => {
      let m = mode & 0o7000;
      root.querySelectorAll<HTMLInputElement>('.perms-body input[type="checkbox"]').forEach((cb) => {
        if (cb.checked) m |= Number(cb.dataset.value);
      });
      return m;
    };
    const refreshOctal = (): void => {
      if (octalEl) octalEl.textContent = (readMode() & 0o7777).toString(8).padStart(3, "0");
    };
    refreshOctal();

    const previouslyFocused = document.activeElement;
    const finish = (result: number | null): void => {
      document.removeEventListener("keydown", onKey, true);
      removeDialog(root);
      root.remove();
      restoreFocus(previouslyFocused);
      resolve(result);
    };
    root.addEventListener("change", refreshOctal);
    root.addEventListener("click", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const action = target.dataset.action;
      if (action === "ok") finish(readMode());
      else if (action === "cancel" || target.classList.contains("dialog-overlay")) finish(null);
    });
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && isTopDialog(root)) {
        consumeKey(e);
        finish(null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(root);
    pushDialog(root);
    root.querySelector<HTMLButtonElement>('[data-action="ok"]')?.focus();
  });
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

/** Restore focus to the element that had it before the dialog opened. */
function restoreFocus(previous: Element | null): void {
  if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
}
