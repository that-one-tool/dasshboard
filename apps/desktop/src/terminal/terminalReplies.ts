/**
 * Recognizes the sequences xterm.js emits through `onData` on its own — replies
 * to terminal queries (device attributes, cursor position, mode/colour reports),
 * focus reports and mouse-tracking reports — as opposed to what the user typed
 * or pasted. Broadcast mode mirrors only the latter: a reply meant for one
 * pane's program would arrive as garbage in the other panes' shells.
 *
 * Known gap: xterm encodes Shift/Ctrl/Alt+F3 as `ESC[1;<mod>R`, byte-for-byte
 * a cursor-position report, so those keys are not broadcast (they still reach
 * the pane they were typed in).
 */

const REPLY_PATTERNS: readonly RegExp[] = [
  /^\x1b\[[?>][\d;]*c$/, // device attributes (DA1 / DA2)
  /^\x1b\[\??\d+;\d+R$/, // cursor position report
  /^\x1b\[\d+n$/, // status report
  /^\x1b\[\??[\d;]+\$y$/, // mode report (DECRQM)
  /^\x1b\[\d+(;\d+)*t$/, // window reports
  /^\x1b\[[IO]$/, // focus in / out
  /^\x1b\[M[\s\S]{3}$/, // X10 / normal mouse report
  /^\x1b\[<\d+;\d+;\d+[Mm]$/, // SGR mouse report
  /^\x1b\][\s\S]*(\x07|\x1b\\)$/, // OSC reply
  /^\x1bP[\s\S]*\x1b\\$/, // DCS reply
];

/** Whether `data` is a terminal-generated reply rather than user input. */
export function isTerminalReply(data: string): boolean {
  return REPLY_PATTERNS.some((pattern) => pattern.test(data));
}
