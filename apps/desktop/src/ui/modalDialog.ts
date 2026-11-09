/**
 * The lifecycle every promise-based modal shares: show on top of the dialog
 * stack, answer from a `data-action` click or a key, then close and give focus
 * back to the element that had it. A handler answering `undefined` means
 * "not an answer", so `T` must not include `undefined`.
 */

import { consumeKey, isTopDialog, pushDialog, removeDialog } from "./dialogStack";

export interface ModalBehaviour<T> {
  /** The answer for the `cancel` button and an overlay click. */
  cancelValue: T;
  /** Answers for the other `data-action` buttons. */
  actions: Record<string, () => T>;
  /** Moves focus into the dialog once it is shown. */
  focus(root: HTMLElement): void;
  /** Answer to a key pressed anywhere; only the newest dialog gets it. */
  keyResult?(e: KeyboardEvent): T | undefined;
}

type Finish<T> = (result: T) => void;

export function createDialogRoot(className: string, html: string): HTMLElement {
  const root = document.createElement("div");
  root.className = `dialog ${className}`;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.innerHTML = html;
  return root;
}

/** Sets an element's text (never markup), if the element exists. */
export function setText(root: ParentNode, selector: string, text: string): void {
  const el = root.querySelector(selector);
  if (el) el.textContent = text;
}

export function cancelOnEscape<T>(cancelValue: T): (e: KeyboardEvent) => T | undefined {
  return (e) => (e.key === "Escape" ? cancelValue : undefined);
}

export function focusAction(action: string): (root: HTMLElement) => void {
  return (root) => root.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)?.focus();
}

export function showModal<T>(root: HTMLElement, behaviour: ModalBehaviour<T>): Promise<T> {
  const full = { keyResult: noAnswer, ...behaviour };
  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement;
    const onKey = (e: KeyboardEvent): void => answerTopKey(root, full.keyResult(e), e, finish);
    const finish: Finish<T> = (result) => {
      document.removeEventListener("keydown", onKey, true);
      closeModal(root, previouslyFocused);
      resolve(result);
    };
    listenForClicks(root, full, finish);
    document.addEventListener("keydown", onKey, true);
    openModal(root, full.focus);
  });
}

function noAnswer(): undefined {
  return undefined;
}

function openModal(root: HTMLElement, focus: (root: HTMLElement) => void): void {
  document.body.appendChild(root);
  pushDialog(root);
  focus(root);
}

function closeModal(root: HTMLElement, previouslyFocused: Element | null): void {
  removeDialog(root);
  root.remove();
  restoreFocus(previouslyFocused);
}

function listenForClicks<T>(root: HTMLElement, behaviour: ModalBehaviour<T>, finish: Finish<T>): void {
  const actions = new Map<string | undefined, () => T>(Object.entries(behaviour.actions));
  actions.set("cancel", () => behaviour.cancelValue);
  root.addEventListener("click", (e) => answer(actions.get(actionOf(e.target))?.(), finish));
}

function answerTopKey<T>(root: HTMLElement, result: T | undefined, e: KeyboardEvent, finish: Finish<T>): void {
  if (result === undefined || !isTopDialog(root)) return;
  consumeKey(e);
  finish(result);
}

function answer<T>(result: T | undefined, finish: Finish<T>): void {
  if (result !== undefined) finish(result);
}

/** The action a click picks: its `data-action`, or `cancel` on the overlay. */
function actionOf(target: EventTarget | null): string | undefined {
  if (!(target instanceof HTMLElement)) return undefined;
  return target.classList.contains("dialog-overlay") ? "cancel" : target.dataset.action;
}

/** Restore focus to the element that had it before the dialog opened. */
function restoreFocus(previous: Element | null): void {
  if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
}
