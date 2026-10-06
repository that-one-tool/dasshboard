/**
 * Clickable URLs in a terminal: the web-links addon underlines them, and a
 * Ctrl+click (Cmd+click on macOS) opens one in the default browser. A plain
 * click stays a text selection, so copy-on-select never opens a link.
 */

import { isMacPlatform } from "../ui/keyboard";
import { t } from "../i18n";
import type { MessageKey } from "../i18n/en";

/** Only http(s) leaves the app; the opener plugin's scope allows no more. */
export function isWebUrl(uri: string): boolean {
  try {
    const { protocol } = new URL(uri);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function wantsLinkOpen(e: MouseEvent, mac: boolean = isMacPlatform()): boolean {
  return mac ? e.metaKey : e.ctrlKey;
}

/** The addon's click handler: opens a web URL on a modified click. */
export function linkActivator(
  open: (url: string) => Promise<void>,
  onError: (message: string) => void,
  mac: boolean = isMacPlatform(),
): (e: MouseEvent, uri: string) => void {
  return (e, uri) => {
    if (!wantsLinkOpen(e, mac) || !isWebUrl(uri)) return;
    open(uri).catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)));
  };
}

/** Tooltip shown while hovering a link. */
export function linkHintKey(mac: boolean = isMacPlatform()): MessageKey {
  return mac ? "pane.link.hintMac" : "pane.link.hint";
}

export interface LinkHandlers {
  activate(e: MouseEvent, uri: string): void;
  hover(e: MouseEvent, uri: string): void;
  leave(): void;
}

/** One set of handlers for both URL detection and OSC 8 hyperlinks (whose
 * xterm default would `window.open` after a `confirm`). `el` shows the hint
 * under the link's real target: an OSC 8 link's text can show any address. */
export function linkHandlers(
  el: HTMLElement,
  open: (url: string) => Promise<void>,
  onError: (message: string) => void,
  mac: boolean = isMacPlatform(),
): LinkHandlers {
  return {
    activate: linkActivator(open, onError, mac),
    hover: (_e, uri) => {
      el.title = `${uri}\n${t(linkHintKey(mac))}`;
    },
    leave: () => el.removeAttribute("title"),
  };
}
