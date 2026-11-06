/** DOM-free rules of the command library: what a command types, and what makes
 * one invalid (mirrors `SavedCommand::validate`). */

import type { SavedCommand } from "../ipc";

export type CommandProblem = "nameRequired" | "textRequired" | "insertOneLine" | "controlChars";

const LINE_BREAK = /\r\n|\r|\n/;
/** Control characters (as Rust's `char::is_control`) but tab and line breaks:
 * one could act on the shell by itself (Ctrl+O runs the line in bash) while
 * staying invisible. */
const CONTROL_CHAR = /\p{Cc}/u;
const ALLOWED_CONTROLS = /[\t\r\n]/g;

/** A run command's lines each end with Enter (a final line break adds no empty
 * line); an insert-only one is typed in as is. */
export function makeCommandInput(command: SavedCommand): string {
  if (!command.run) return command.text;
  const lines = command.text.replace(/(\r\n|\r|\n)$/, "").split(LINE_BREAK);
  return lines.map((line) => `${line}\r`).join("");
}

const RULES: ReadonlyArray<[CommandProblem, (command: SavedCommand) => boolean]> = [
  ["nameRequired", (command) => command.name.trim() === ""],
  ["textRequired", (command) => command.text.trim() === ""],
  ["insertOneLine", (command) => !command.run && LINE_BREAK.test(command.text)],
  ["controlChars", (command) => CONTROL_CHAR.test(command.text.replace(ALLOWED_CONTROLS, ""))],
];

export function findCommandProblem(command: SavedCommand): CommandProblem | null {
  return RULES.find(([, isBroken]) => isBroken(command))?.[0] ?? null;
}

export function sortCommands(commands: readonly SavedCommand[]): SavedCommand[] {
  return [...commands].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
