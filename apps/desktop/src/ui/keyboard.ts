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
