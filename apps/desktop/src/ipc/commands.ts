import { invokeChecked, invokeMutation } from "./invoke";

/** A command library entry (mirrors `command_library::SavedCommand`). `run`:
 * each line is followed by Enter; otherwise the single line is typed in for
 * the user to finish. */
export interface SavedCommand {
  id: string;
  name: string;
  text: string;
  run: boolean;
}

export async function listCommands(): Promise<SavedCommand[]> {
  return invokeChecked<SavedCommand[]>("list_commands");
}

/** Creates (empty `id`) or replaces a command; returns it as saved. */
export async function saveCommand(command: SavedCommand): Promise<SavedCommand> {
  return invokeMutation<SavedCommand>("save_command", { command });
}

export async function deleteCommand(id: string): Promise<void> {
  await invokeMutation<void>("delete_command", { id });
}
