/**
 * Toast notifications: a small stack of transient status messages in a
 * bottom-corner container, used for both errors and success confirmations.
 *
 * A burst of identical back-to-back calls (e.g. one `onError` per failed pane
 * in a `Promise.allSettled`) would otherwise stack unboundedly (F7): an exact
 * repeat of the last toast just restarts its dismiss timer instead of adding a
 * node, and the container is capped at `TOAST_MAX_CONCURRENT` distinct toasts,
 * dropping the oldest first.
 */

const TOAST_DURATION_MS = 4000;
/** Max toasts stacked at once; a burst (e.g. N failed panes) drops the oldest. */
const TOAST_MAX_CONCURRENT = 3;

/** Pending auto-dismiss timers, keyed by toast element (F7). */
const toastTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

function getToastContainer(): HTMLElement {
  let container = document.querySelector<HTMLElement>(".toast-container");
  if (!container) {
    container = document.createElement("div");
    container.className = "toast-container";
    document.body.appendChild(container);
  }
  return container;
}

/** (Re)starts a toast's 4s auto-dismiss timer, clearing any prior one. */
function scheduleToastRemoval(toast: HTMLElement): void {
  const existing = toastTimers.get(toast);
  if (existing !== undefined) clearTimeout(existing);
  toastTimers.set(
    toast,
    setTimeout(() => toast.remove(), TOAST_DURATION_MS),
  );
}

/** Whether `el` already carries this exact toast message/type. */
function toastMatches(el: HTMLElement, message: string, type: string): boolean {
  return el.dataset.message === message && el.dataset.type === type;
}

/** The most recently shown toast, if it matches this message/type exactly. */
function findDuplicateToast(
  container: HTMLElement,
  message: string,
  type: string,
): HTMLElement | null {
  const last = container.lastElementChild;
  if (!(last instanceof HTMLElement)) return null;
  return toastMatches(last, message, type) ? last : null;
}

/** Drops the oldest toasts so at most `TOAST_MAX_CONCURRENT - 1` remain before adding a new one. */
function capToastCount(container: HTMLElement): void {
  while (container.children.length >= TOAST_MAX_CONCURRENT) {
    container.firstElementChild?.remove();
  }
}

/**
 * Shows a toast notification for errors or success messages.
 *
 * A burst of identical back-to-back calls (e.g. one `onError` per failed pane
 * in a `Promise.allSettled`) would otherwise stack unboundedly (F7): an exact
 * repeat of the last toast just restarts its dismiss timer instead of adding
 * a new node, and the container is capped at `TOAST_MAX_CONCURRENT` distinct
 * toasts, dropping the oldest first.
 */
export function showToast(
  message: string,
  type: "error" | "success" = "error",
): void {
  const container = getToastContainer();

  const duplicate = findDuplicateToast(container, message, type);
  if (duplicate) {
    scheduleToastRemoval(duplicate);
    return;
  }

  capToastCount(container);

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toast.dataset.message = message;
  toast.dataset.type = type;
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");

  container.appendChild(toast);
  scheduleToastRemoval(toast);
}
