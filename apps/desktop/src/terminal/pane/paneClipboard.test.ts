/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const confirmMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../../ui/confirm", () => ({ confirm: confirmMock }));

import { PaneClipboard } from "./paneClipboard";

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("PaneClipboard", () => {
  let terminalEl: HTMLElement;
  let readText: ReturnType<typeof vi.fn<() => Promise<string>>>;
  let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
  let paste: ReturnType<typeof vi.fn<(text: string) => void>>;
  let canPaste: boolean;
  let selection: string;
  let clipboard: PaneClipboard;

  beforeEach(() => {
    vi.useFakeTimers();
    confirmMock.mockClear().mockResolvedValue(true);
    document.body.innerHTML = '<div class="pane-terminal"><textarea></textarea></div>';
    terminalEl = document.querySelector<HTMLElement>(".pane-terminal")!;
    readText = vi.fn(async () => "ls");
    writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText, writeText } });
    paste = vi.fn<(text: string) => void>();
    canPaste = true;
    selection = "";
    clipboard = new PaneClipboard(terminalEl, {
      selection: () => selection,
      canPaste: () => canPaste,
      paste,
    });
  });
  afterEach(() => {
    clipboard.dispose();
    vi.useRealTimers();
  });

  function nativePaste(text: string): Event {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data });
    terminalEl.querySelector("textarea")!.dispatchEvent(event);
    return event;
  }

  it("pastes the clipboard on right-click", async () => {
    const event = new Event("contextmenu", { bubbles: true, cancelable: true });
    terminalEl.dispatchEvent(event);
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(paste).toHaveBeenCalledWith("ls");
  });

  it("does not even read the clipboard when it may not paste", async () => {
    canPaste = false;
    terminalEl.dispatchEvent(new Event("contextmenu"));
    await flush();
    expect(readText).not.toHaveBeenCalled();
  });

  it("confirms a multi-line paste and pastes only once accepted", async () => {
    readText.mockResolvedValue("a\nb\n");
    clipboard.pasteFromShortcut();
    await flush();
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(paste).toHaveBeenCalledOnce();

    confirmMock.mockResolvedValue(false);
    clipboard.pasteFromShortcut();
    await flush();
    expect(paste).toHaveBeenCalledOnce();
  });

  it("drops a paste when the session ended while the confirm was open", async () => {
    readText.mockResolvedValue("a\nb\n");
    let accept: (ok: boolean) => void = () => {};
    confirmMock.mockReturnValue(new Promise((resolve) => (accept = resolve)));
    clipboard.pasteFromShortcut();
    await flush();
    canPaste = false;
    accept(true);
    await flush();
    expect(paste).not.toHaveBeenCalled();
  });

  it("pastes nothing for an empty clipboard", async () => {
    readText.mockResolvedValue("");
    clipboard.pasteFromShortcut();
    await flush();
    expect(paste).not.toHaveBeenCalled();
  });

  it("takes over a native paste", async () => {
    const event = nativePaste("pwd");
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(paste).toHaveBeenCalledWith("pwd");
  });

  it("ignores the native paste the shortcut's own press may still fire, until the key is released", async () => {
    clipboard.pasteFromShortcut();
    nativePaste("pwd");
    await flush();
    expect(paste).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new KeyboardEvent("keyup"));
    nativePaste("pwd");
    await flush();
    expect(paste).toHaveBeenCalledTimes(2);
  });

  it("a window blur also ends the shortcut's press", async () => {
    clipboard.pasteFromShortcut();
    window.dispatchEvent(new Event("blur"));
    nativePaste("pwd");
    await flush();
    expect(paste).toHaveBeenCalledWith("pwd");
  });

  it("copies the selection when a mouse press in the terminal is released", async () => {
    selection = "picked";
    terminalEl.dispatchEvent(new MouseEvent("mousedown"));
    document.dispatchEvent(new MouseEvent("mouseup"));
    vi.runAllTimers();
    await flush();
    expect(writeText).toHaveBeenCalledWith("picked");
  });

  it("does not copy on a release that did not start in the terminal", () => {
    selection = "picked";
    document.dispatchEvent(new MouseEvent("mouseup"));
    vi.runAllTimers();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("does not copy an empty selection", () => {
    terminalEl.dispatchEvent(new MouseEvent("mousedown"));
    document.dispatchEvent(new MouseEvent("mouseup"));
    vi.runAllTimers();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("stops listening to the page once disposed", () => {
    selection = "picked";
    terminalEl.dispatchEvent(new MouseEvent("mousedown"));
    clipboard.dispose();
    document.dispatchEvent(new MouseEvent("mouseup"));
    vi.runAllTimers();
    expect(writeText).not.toHaveBeenCalled();
  });
});
