/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Terminal } from "@xterm/xterm";
import type { TerminalSettings } from "../../ipc";
import { DEFAULT_TERMINAL_SETTINGS, withIconFont, xtermThemeFor } from "../terminalSettings";
import { linkHandlers, type LinkHandlers } from "../links";
import { applyTerminalOptions, makeTerminal, type PaneTerminal } from "./terminalFactory";

const custom: TerminalSettings = {
  ...DEFAULT_TERMINAL_SETTINGS,
  fontFamily: "Fira Code",
  fontSize: 17,
  scrollback: 1234,
};

describe("terminalFactory", () => {
  let el: HTMLElement;
  let links: LinkHandlers;
  const opened: Terminal[] = [];

  beforeEach(() => {
    document.body.innerHTML = '<div class="pane-terminal"></div>';
    el = document.querySelector<HTMLElement>(".pane-terminal")!;
    links = linkHandlers(el, vi.fn(async () => {}), vi.fn());
  });
  afterEach(() => {
    for (const terminal of opened.splice(0)) terminal.dispose();
  });

  function make(settings: TerminalSettings = custom): PaneTerminal {
    const made = makeTerminal(el, settings, links);
    opened.push(made.terminal);
    return made;
  }

  it("opens a terminal in the element with the given settings", () => {
    const { terminal } = make();
    expect(el.querySelector(".xterm")).not.toBeNull();
    expect(terminal.options.fontSize).toBe(17);
    expect(terminal.options.scrollback).toBe(1234);
    expect(terminal.options.fontFamily).toBe(withIconFont("Fira Code"));
    expect(terminal.options.theme).toEqual(xtermThemeFor(custom.theme));
  });

  it("measures wide glyphs with the Unicode 11 table", () => {
    expect(make().terminal.unicode.activeVersion).toBe("11");
  });

  it("opens OSC 8 links through the pane's link handlers", () => {
    expect(make().terminal.options.linkHandler).toBe(links);
  });

  it("returns its fit and search addons", () => {
    const { fitAddon, searchAddon } = make();
    expect(typeof fitAddon.fit).toBe("function");
    expect(typeof searchAddon.findNext).toBe("function");
  });

  it("applies new settings to a live terminal", () => {
    const { terminal } = make(DEFAULT_TERMINAL_SETTINGS);
    applyTerminalOptions(terminal, custom);
    expect(terminal.options.fontSize).toBe(17);
    expect(terminal.options.scrollback).toBe(1234);
    expect(terminal.options.fontFamily).toBe(withIconFont("Fira Code"));
  });
});
