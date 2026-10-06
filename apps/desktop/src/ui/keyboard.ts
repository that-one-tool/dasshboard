/**
 * Keyboard-shortcut modifiers across platforms: macOS users reach for Cmd
 * where Windows/Linux use Ctrl, so app shortcuts accept either there.
 */

export function isMacPlatform(userAgent: string = navigator.userAgent): boolean {
  return userAgent.includes("Macintosh");
}

/** Ctrl, or Cmd on macOS. Win+… is left alone elsewhere (the OS owns it). */
export function isShortcutModifier(e: KeyboardEvent, mac: boolean = isMacPlatform()): boolean {
  return e.ctrlKey || (mac && e.metaKey);
}

const MODIFIERS = ["ctrlKey", "altKey", "shiftKey", "metaKey"] as const;

/** Ctrl alone, or Cmd alone on macOS, where Ctrl+key stays the terminal's.
 * Never with Alt: Ctrl+Alt is AltGr on Windows, which types characters. */
export function isOnlyShortcutModifier(e: KeyboardEvent, mac: boolean = isMacPlatform()): boolean {
  return heldModifiers(e) === (mac ? "metaKey" : "ctrlKey");
}

/** The modifiers held, e.g. `"ctrlKey+shiftKey"` (always in this order). */
export function heldModifiers(e: KeyboardEvent): string {
  return MODIFIERS.filter((modifier) => e[modifier]).join("+");
}

/** The key a letter shortcut means, lower case: the key's own letter on a
 * Latin layout (wherever it sits: AZERTY's W is W), else the letter at its
 * QWERTY position, so Ctrl+Shift+T still works on a Cyrillic or Greek layout.
 * A named key (Tab) is its name. */
export function shortcutLetter(e: KeyboardEvent): string {
  const key = e.key.toLowerCase();
  if (/^[a-z]$/.test(key)) return key;
  const position = /^Key([A-Z])$/.exec(e.code)?.[1];
  return position?.toLowerCase() ?? key;
}
