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

export interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the accept button as destructive (red) — deletes, session teardown. */
  danger?: boolean;
}

export function confirm(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  const title = options.title ?? "Please confirm";
  const confirmLabel = options.confirmLabel ?? "Continue";
  const cancelLabel = options.cancelLabel ?? "Cancel";
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
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(root);
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
          <button type="button" class="btn btn-secondary" data-action="cancel">Cancel</button>
          <button type="button" class="btn btn-primary" data-action="ok">OK</button>
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
    input?.focus();
    input?.select();
  });
}

/** Restore focus to the element that had it before the dialog opened. */
function restoreFocus(previous: Element | null): void {
  if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
}
