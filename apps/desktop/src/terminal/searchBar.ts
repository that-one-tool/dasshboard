/**
 * The pane's find bar over the terminal (Ctrl+Shift+F, Cmd+F on macOS): an
 * incremental search through the scrollback via xterm's search addon, with a
 * match count, previous/next (Shift+Enter / Enter) and Esc to close. The pane
 * hands it each new terminal's addon through `attach`.
 */

import type { ISearchOptions, ISearchResultChangeEvent } from "@xterm/addon-search";
import type { TerminalTheme } from "../ipc";
import { t } from "../i18n";
import type { MessageKey } from "../i18n/en";
import { heldModifiers, isMacPlatform } from "../ui/keyboard";
import { requireEl } from "../ui/dom";
import { chevronDownIcon, chevronUpIcon, closeIcon } from "../ui/icons";

/** Matches highlighted at most (the addon's default); the count caps there. */
export const SEARCH_HIGHLIGHT_LIMIT = 1000;

/** The slice of xterm's `SearchAddon` the bar drives. */
export interface SearchTarget {
  findNext(term: string, options?: ISearchOptions): boolean;
  findPrevious(term: string, options?: ISearchOptions): boolean;
  clearDecorations(): void;
  onDidChangeResults(listener: (e: ISearchResultChangeEvent) => void): { dispose(): void };
}

export interface SearchBarOptions {
  /** Called after the bar closes (the pane refocuses its terminal). */
  onClose: () => void;
  /** The terminal theme, for the highlight colors. */
  theme: () => TerminalTheme;
}

/** Plain Ctrl+F stays the shell's (cursor forward), and vim's/less's. */
export function isFindShortcut(e: KeyboardEvent, mac: boolean = isMacPlatform()): boolean {
  return e.code === "KeyF" && heldModifiers(e) === (mac ? "metaKey" : "ctrlKey+shiftKey");
}

export function findKeyHintKey(mac: boolean = isMacPlatform()): MessageKey {
  return mac ? "pane.findMac" : "pane.find";
}

/** `3/12`; just the count when the addon has no active match among the
 * highlighted ones (past the limit). */
export function resultLabel(index: number, count: number, limit: number): string {
  if (count === 0) return t("pane.search.none");
  if (index < 0) return countText(count, limit);
  return `${index + 1}/${countText(count, limit)}`;
}

function countText(count: number, limit: number): string {
  return count >= limit ? `${limit}+` : String(count);
}

const FIND_METHOD = { next: "findNext", previous: "findPrevious" } as const;

type Decorations = NonNullable<ISearchOptions["decorations"]>;

// The addon only reports match counts when it draws decorations. Text keeps
// its color over them, so each background suits its theme's foreground.
const DARK_DECORATIONS: Decorations = {
  matchBackground: "#3a4a73",
  matchOverviewRuler: "#3a4a73",
  activeMatchBackground: "#8a6d1f",
  activeMatchColorOverviewRuler: "#8a6d1f",
};

const LIGHT_DECORATIONS: Decorations = {
  matchBackground: "#cdd9ff",
  matchOverviewRuler: "#cdd9ff",
  activeMatchBackground: "#ffd166",
  activeMatchColorOverviewRuler: "#ffd166",
};

export function searchDecorations(theme: TerminalTheme): Decorations {
  return theme === "light" ? LIGHT_DECORATIONS : DARK_DECORATIONS;
}

export class TerminalSearchBar {
  private readonly root: HTMLElement;
  private readonly options: SearchBarOptions;
  private target: SearchTarget | null = null;
  private resultsListener: { dispose(): void } | null = null;
  private readonly keyActions: Record<string, (e: KeyboardEvent) => void> = {
    Enter: (e) => this.search(e.shiftKey ? "previous" : "next", false),
    Escape: () => this.close(),
  };

  constructor(host: HTMLElement, options: SearchBarOptions) {
    this.options = options;
    this.root = document.createElement("div");
    this.root.className = "pane-search";
    this.root.hidden = true;
    this.root.setAttribute("role", "search");
    this.root.innerHTML = `
      <input type="text" class="pane-search-input" spellcheck="false" autocomplete="off">
      <span class="pane-search-count" aria-live="polite"></span>
      <button type="button" class="btn btn-icon pane-search-prev">${chevronUpIcon}</button>
      <button type="button" class="btn btn-icon pane-search-next">${chevronDownIcon}</button>
      <button type="button" class="btn btn-icon pane-search-close">${closeIcon}</button>
    `;
    host.appendChild(this.root);
    this.retranslate();
    this.bindEvents();
  }

  /** Searches `target` from now on (`null`: no terminal). Closes the bar. */
  attach(target: SearchTarget | null): void {
    this.resultsListener?.dispose();
    this.target = target;
    this.resultsListener = target?.onDidChangeResults((e) => this.showCount(e)) ?? null;
    this.root.hidden = true;
  }

  open(): void {
    this.root.hidden = false;
    this.input().focus();
    this.input().select();
    this.search("next", true);
  }

  close(): void {
    this.root.hidden = true;
    this.target?.clearDecorations();
    this.count().textContent = "";
    this.options.onClose();
  }

  isOpen(): boolean {
    return !this.root.hidden;
  }

  retranslate(): void {
    this.input().placeholder = t("pane.search.placeholder");
    this.input().setAttribute("aria-label", t("pane.search.placeholder"));
    this.label(".pane-search-prev", "pane.search.previous");
    this.label(".pane-search-next", "pane.search.next");
    this.label(".pane-search-close", "pane.search.close");
  }

  private bindEvents(): void {
    this.input().addEventListener("input", () => this.search("next", true));
    this.input().addEventListener("keydown", (e) => this.onKeyDown(e));
    this.button(".pane-search-prev").addEventListener("click", () => this.search("previous", false));
    this.button(".pane-search-next").addEventListener("click", () => this.search("next", false));
    this.button(".pane-search-close").addEventListener("click", () => this.close());
  }

  private onKeyDown(e: KeyboardEvent): void {
    const handled = this.handleKey(e);
    if (handled) e.preventDefault();
  }

  private handleKey(e: KeyboardEvent): boolean {
    const action = isFindShortcut(e) ? () => this.input().select() : this.keyActions[e.key];
    action?.(e);
    return action !== undefined;
  }

  /** `incremental` (typing) keeps the current match if it still matches. */
  private search(direction: "next" | "previous", incremental: boolean): void {
    const term = this.input().value;
    if (!this.target) return;
    if (!term) return this.clearResults();
    const options = { incremental, decorations: searchDecorations(this.options.theme()) };
    this.target[FIND_METHOD[direction]](term, options);
  }

  private clearResults(): void {
    this.target?.clearDecorations();
    this.count().textContent = "";
  }

  private showCount(e: ISearchResultChangeEvent): void {
    if (!this.input().value) return;
    this.count().textContent = resultLabel(e.resultIndex, e.resultCount, SEARCH_HIGHLIGHT_LIMIT);
  }

  private label(selector: string, key: MessageKey): void {
    const button = this.button(selector);
    button.title = t(key);
    button.setAttribute("aria-label", t(key));
  }

  private input(): HTMLInputElement {
    return requireEl<HTMLInputElement>(this.root, ".pane-search-input");
  }

  private count(): HTMLElement {
    return requireEl<HTMLElement>(this.root, ".pane-search-count");
  }

  private button(selector: string): HTMLButtonElement {
    return requireEl<HTMLButtonElement>(this.root, selector);
  }
}
