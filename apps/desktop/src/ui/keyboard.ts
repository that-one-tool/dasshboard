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
