/** Builds a pane's xterm.js terminal with its addons, from the app settings. */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { TerminalSettings } from "../../ipc";
import type { LinkHandlers } from "../links";
import { SEARCH_HIGHLIGHT_LIMIT } from "../searchBar";
import { withIconFont, xtermThemeFor } from "../terminalSettings";

export interface PaneTerminal {
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
}

/** Opens a fitted terminal in `el`. */
export function makeTerminal(el: HTMLElement, settings: TerminalSettings, links: LinkHandlers): PaneTerminal {
  const terminal = new Terminal({
    cursorBlink: true,
    // Required to access `terminal.unicode` and load the Unicode 11 addon.
    allowProposedApi: true,
    linkHandler: links,
  });
  applyTerminalOptions(terminal, settings);
  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon({ highlightLimit: SEARCH_HIGHLIGHT_LIMIT });
  loadAddons(terminal, [fitAddon, searchAddon, new WebLinksAddon(links.activate, links)]);
  terminal.open(el);
  fitAddon.fit();
  return { terminal, fitAddon, searchAddon };
}

export function applyTerminalOptions(terminal: Terminal, settings: TerminalSettings): void {
  terminal.options.fontSize = settings.fontSize;
  terminal.options.fontFamily = withIconFont(settings.fontFamily);
  terminal.options.scrollback = settings.scrollback;
  terminal.options.theme = xtermThemeFor(settings.theme);
}

/** Unicode 11 width table: CJK, emoji and combining marks at their real cell
 * width, so wide glyphs don't misalign the cursor (xterm defaults to Unicode 6). */
function loadAddons(terminal: Terminal, addons: Parameters<Terminal["loadAddon"]>[0][]): void {
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";
  for (const addon of addons) terminal.loadAddon(addon);
}
