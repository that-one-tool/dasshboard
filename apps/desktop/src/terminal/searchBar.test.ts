/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  TerminalSearchBar,
  findKeyHintKey,
  isFindShortcut,
  resultLabel,
  searchDecorations,
  type SearchTarget,
} from "./searchBar";
import { setLocale } from "../i18n";

type ResultsListener = (e: { resultIndex: number; resultCount: number }) => void;

function fakeTarget() {
  let listener: ResultsListener | null = null;
  const dispose = vi.fn();
  const target = {
    findNext: vi.fn(() => true),
    findPrevious: vi.fn(() => true),
    clearDecorations: vi.fn(),
    onDidChangeResults: (l: ResultsListener) => {
      listener = l;
      return { dispose };
    },
  } satisfies SearchTarget;
  return { target, dispose, emit: (e: Parameters<ResultsListener>[0]) => listener?.(e) };
}

const keyEvent = (mods: Partial<KeyboardEvent>) =>
  ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, code: "KeyF", ...mods }) as KeyboardEvent;

describe("isFindShortcut", () => {
  it("is Ctrl+Shift+F elsewhere, Cmd+F on macOS", () => {
    expect(isFindShortcut(keyEvent({ ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(isFindShortcut(keyEvent({ metaKey: true }), true)).toBe(true);
  });

  it("leaves plain Ctrl+F (cursor forward) to the shell", () => {
    expect(isFindShortcut(keyEvent({ ctrlKey: true }), false)).toBe(false);
    expect(isFindShortcut(keyEvent({ ctrlKey: true }), true)).toBe(false);
    expect(isFindShortcut(keyEvent({ ctrlKey: true, shiftKey: true, code: "KeyG" }), false)).toBe(false);
  });

  it("names the platform's shortcut in the button tooltip", () => {
    expect(findKeyHintKey(false)).toBe("pane.find");
    expect(findKeyHintKey(true)).toBe("pane.findMac");
  });
});

describe("resultLabel", () => {
  beforeEach(() => setLocale("en"));

  it("shows the active match and the count", () => {
    expect(resultLabel(2, 12, 1000)).toBe("3/12");
  });

  it("says when nothing matches", () => {
    expect(resultLabel(-1, 0, 1000)).toBe("No results");
  });

  it("marks a count capped at the highlight limit", () => {
    expect(resultLabel(4, 1000, 1000)).toBe("5/1000+");
  });

  it("shows only the count when the active match is past the highlighted ones", () => {
    expect(resultLabel(-1, 1000, 1000)).toBe("1000+");
  });
});

describe("searchDecorations", () => {
  it("has a palette per terminal theme, in hex (xterm requires it)", () => {
    for (const theme of ["dark", "light"] as const) {
      const d = searchDecorations(theme);
      expect(d.matchBackground).toMatch(/^#[0-9a-f]{6}$/);
      expect(d.activeMatchBackground).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(searchDecorations("dark")).not.toEqual(searchDecorations("light"));
  });
});

describe("TerminalSearchBar", () => {
  let host: HTMLElement;
  let onClose: ReturnType<typeof vi.fn<() => void>>;
  let bar: TerminalSearchBar;

  const el = <T extends Element>(selector: string) => {
    const found = host.querySelector<T>(selector);
    if (!found) throw new Error(`test: missing ${selector}`);
    return found;
  };
  const input = () => el<HTMLInputElement>(".pane-search-input");
  const type = (text: string) => {
    input().value = text;
    input().dispatchEvent(new Event("input"));
  };
  const press = (key: string, mods: Partial<KeyboardEventInit> = {}) =>
    input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }));

  beforeEach(() => {
    setLocale("en");
    document.body.innerHTML = '<div id="host"></div>';
    host = document.getElementById("host") as HTMLElement;
    onClose = vi.fn<() => void>();
    bar = new TerminalSearchBar(host, { onClose, theme: () => "dark" });
  });

  it("starts hidden and opens focused", () => {
    expect(bar.isOpen()).toBe(false);
    bar.open();
    expect(bar.isOpen()).toBe(true);
    expect(document.activeElement).toBe(input());
  });

  it("searches incrementally as you type", () => {
    const { target } = fakeTarget();
    bar.attach(target);
    bar.open();
    type("err");
    expect(target.findNext).toHaveBeenLastCalledWith(
      "err",
      expect.objectContaining({ incremental: true, decorations: searchDecorations("dark") }),
    );
  });

  it("goes to the next match on Enter and the previous on Shift+Enter", () => {
    const { target } = fakeTarget();
    bar.attach(target);
    bar.open();
    type("err");
    press("Enter");
    expect(target.findNext).toHaveBeenLastCalledWith("err", expect.objectContaining({ incremental: false }));
    press("Enter", { shiftKey: true });
    expect(target.findPrevious).toHaveBeenCalledWith("err", expect.anything());
  });

  it("clears the highlights when the term is emptied", () => {
    const { target } = fakeTarget();
    bar.attach(target);
    bar.open();
    type("err");
    target.findNext.mockClear();
    type("");
    expect(target.findNext).not.toHaveBeenCalled();
    expect(target.clearDecorations).toHaveBeenCalled();
  });

  it("shows the match count reported by the terminal", () => {
    const { target, emit } = fakeTarget();
    bar.attach(target);
    bar.open();
    type("err");
    emit({ resultIndex: 0, resultCount: 4 });
    expect(el(".pane-search-count").textContent).toBe("1/4");
  });

  it("closes on Escape, clearing highlights and handing focus back", () => {
    const { target } = fakeTarget();
    bar.attach(target);
    bar.open();
    press("Escape");
    expect(bar.isOpen()).toBe(false);
    expect(target.clearDecorations).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("closes from its × button", () => {
    bar.open();
    el<HTMLButtonElement>(".pane-search-close").click();
    expect(bar.isOpen()).toBe(false);
  });

  it("re-runs the term when reopened", () => {
    const { target } = fakeTarget();
    bar.attach(target);
    bar.open();
    type("err");
    press("Escape");
    target.findNext.mockClear();
    bar.open();
    expect(target.findNext).toHaveBeenCalledWith("err", expect.anything());
  });

  it("closes on a new terminal and stops listening to the old one", () => {
    const first = fakeTarget();
    bar.attach(first.target);
    bar.open();
    bar.attach(fakeTarget().target);
    expect(bar.isOpen()).toBe(false);
    expect(first.dispose).toHaveBeenCalled();
  });

  it("is a no-op without a terminal", () => {
    bar.attach(null);
    bar.open();
    type("err");
    press("Enter");
    expect(bar.isOpen()).toBe(true);
  });

  it("relabels itself on a language change", () => {
    setLocale("fr");
    bar.retranslate();
    expect(input().placeholder).not.toBe("Find");
    setLocale("en");
  });
});
