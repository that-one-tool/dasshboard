/**
 * The open modal dialogs, oldest first. Dialogs listen for Escape/Enter on
 * `document` (so a key still works once focus fell back to the body), which
 * means every open dialog sees the same key press: only the newest may act on
 * it — Escape in a confirm opened over another dialog must not close both.
 */
const openDialogs: Element[] = [];

/** Records `root` as the newest open dialog — moving it to the top if it was
 * already open (a persistent dialog shown again, re-appended to paint on top). */
export function pushDialog(root: Element): void {
  removeDialog(root);
  openDialogs.push(root);
}

/** Forgets `root` once it closes or hides. */
export function removeDialog(root: Element): void {
  const index = openDialogs.indexOf(root);
  if (index >= 0) openDialogs.splice(index, 1);
}

/** Ends a key press a dialog acted on, so the dialog beneath — on top once
 * this one closes — doesn't act on it too. */
export function consumeKey(e: KeyboardEvent): void {
  e.preventDefault();
  e.stopImmediatePropagation();
}

/** Whether `root` is the newest open dialog, the one a document-level key is for. */
export function isTopDialog(root: Element): boolean {
  return openDialogs[openDialogs.length - 1] === root;
}
