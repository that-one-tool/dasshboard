/**
 * A pane's clipboard: copy on select, and paste from the shortcut, a
 * right-click or a native paste event, all through the multi-line confirm.
 * Its listeners on the persistent `.pane-terminal` node live as long as the
 * pane: attached per session, they would pile up and paste N times.
 */

import { t } from "../../i18n";
import { confirm } from "../../ui/confirm";
import { isMultilinePaste, pasteConfirmMessage, sanitizePaste } from "../paste";

export interface ClipboardTarget {
  selection(): string | undefined;
  /** Whether a paste may reach the session (connected, with a terminal). */
  canPaste(): boolean;
  paste(text: string): void;
}

export class PaneClipboard {
  /** A mouse press in the terminal may be selecting: copied on release. */
  private mouseSelecting = false;
  /** From the paste shortcut's press to the next key release (or window blur):
   * WebView2 can still fire a native paste for that press despite the
   * keydown's preventDefault, and the shortcut has already pasted. */
  private shortcutPasteHeld = false;

  constructor(
    terminalEl: HTMLElement,
    private readonly target: ClipboardTarget,
  ) {
    terminalEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      void this.pasteFromClipboard();
    });
    // Captured before xterm's own handler, which would skip the confirm.
    terminalEl.addEventListener("paste", (e) => this.onNativePaste(e), true);
    // Captured before xterm can stop the press; the release is on `document`,
    // as a drag may end outside the pane.
    terminalEl.addEventListener("mousedown", () => (this.mouseSelecting = true), true);
    document.addEventListener("mouseup", this.onMouseUp);
    window.addEventListener("keyup", this.endShortcutPaste, true);
    window.addEventListener("blur", this.endShortcutPaste);
  }

  pasteFromShortcut(): void {
    this.shortcutPasteHeld = true;
    void this.pasteFromClipboard();
  }

  dispose(): void {
    document.removeEventListener("mouseup", this.onMouseUp);
    window.removeEventListener("keyup", this.endShortcutPaste, true);
    window.removeEventListener("blur", this.endShortcutPaste);
  }

  private readonly endShortcutPaste = (): void => {
    this.shortcutPasteHeld = false;
  };

  /** Copies on the release that ends a selection, not on every selection
   * change, which the find bar's matches also make. */
  private readonly onMouseUp = (): void => {
    if (!this.mouseSelecting) return;
    this.mouseSelecting = false;
    // After xterm's own release handling has settled the selection.
    window.setTimeout(() => this.copySelection(), 0);
  };

  private copySelection(): void {
    const selection = this.target.selection();
    if (selection) void writeClipboard(selection);
  }

  private onNativePaste(e: ClipboardEvent): void {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (this.shortcutPasteHeld) return;
    void this.pasteText(eventText(e));
  }

  private async pasteFromClipboard(): Promise<void> {
    if (!this.target.canPaste()) return;
    await this.pasteText(await readClipboard());
  }

  private async pasteText(clipboardText: string): Promise<void> {
    const text = sanitizePaste(clipboardText);
    if (!this.mayPaste(text)) return;
    if (await confirmPaste(text)) this.pasteIfStillAllowed(text);
  }

  private mayPaste(text: string): boolean {
    return text !== "" && this.target.canPaste();
  }

  /** The session may have ended while the confirm was open. */
  private pasteIfStillAllowed(text: string): void {
    if (this.target.canPaste()) this.target.paste(text);
  }
}

/** A multi-line paste can run several commands at once: confirm it first. */
async function confirmPaste(text: string): Promise<boolean> {
  if (!isMultilinePaste(text)) return true;
  return confirm(pasteConfirmMessage(text), {
    title: t("pane.paste.title"),
    confirmLabel: t("pane.paste.confirm"),
  });
}

function eventText(e: ClipboardEvent): string {
  return e.clipboardData?.getData("text/plain") ?? "";
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard unavailable — ignore (copy-on-select is best effort) */
  }
}

async function readClipboard(): Promise<string> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}
