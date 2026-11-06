/**
 * The Commands sidebar card: the command library (add / edit / delete,
 * import / export), each command sent with a click to the active tab's
 * focused pane, or to every connected pane while it broadcasts.
 */

import {
  deleteCommand,
  exportCommands,
  importCommands,
  listCommands,
  saveCommand,
  type SavedCommand,
} from "../ipc";
import { confirm } from "../ui/confirm";
import { pickJsonOpenPath, pickJsonSavePath } from "../ui/fileDialog";
import { exportIcon, importIcon, pencilIcon, plusIcon, trashIcon } from "../ui/icons";
import { getErrorMessage } from "../ui/errorMessage";
import { requireEl } from "../ui/dom";
import { t, tp } from "../i18n";
import { openCommandDialog } from "./commandDialog";
import { makeCommandInput, sortCommands } from "./commandText";

/** A pane a command can be sent to; `send` reaches only the session the pane
 * had when listed (a no-op once it ends, even if the pane reconnects). */
export interface CommandTarget {
  name: string;
  send(data: string): void;
}

export interface CommandsPanelOptions {
  getTargets(): CommandTarget[];
  /** Hands the keyboard back to the terminal, to finish a command sent without Enter. */
  afterSend(): void;
  onError(message: string): void;
  onInfo(message: string): void;
  onSuccess(message: string): void;
}

const NEW_COMMAND: SavedCommand = { id: "", name: "", text: "", run: true };

export function initCommandsPanel(options: CommandsPanelOptions): CommandsPanel | null {
  const root = document.querySelector<HTMLElement>(".command-list");
  return root ? new CommandsPanel(root, options) : null;
}

export class CommandsPanel {
  private commands: SavedCommand[] = [];
  /** One editor at a time: a double click must not open two. */
  private editing = false;
  /** One send at a time, so a click during the confirm sends nothing more. */
  private sending = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly options: CommandsPanelOptions,
  ) {
    this.render();
  }

  /** Re-lists the library; a failed read keeps the list shown. */
  async reload(): Promise<void> {
    try {
      this.commands = sortCommands(await listCommands());
    } catch (error) {
      this.options.onError(getErrorMessage(error));
      return;
    }
    this.render();
  }

  retranslate(): void {
    this.render();
  }

  private render(): void {
    this.root.innerHTML = headerMarkup();
    this.wireHeader();
    if (this.commands.length === 0) this.root.appendChild(emptyMessage());
    for (const command of this.commands) this.root.appendChild(this.makeRow(command));
  }

  private wireHeader(): void {
    const on = (selector: string, action: () => Promise<void>): void =>
      requireEl(this.root, selector).addEventListener("click", () => void action());
    on(".command-export-btn", () => this.exportAll());
    on(".command-import-btn", () => this.importAll());
    on(".command-add-btn", () => this.edit(NEW_COMMAND));
  }

  private makeRow(command: SavedCommand): HTMLElement {
    const row = document.createElement("div");
    row.className = "command-item";
    row.innerHTML = rowMarkup();
    requireEl(row, ".command-item-name").textContent = command.name;
    const text = requireEl<HTMLElement>(row, ".command-item-text");
    text.textContent = previewOf(command.text);
    text.title = command.text;
    requireEl(row, ".command-item-no-enter").toggleAttribute("hidden", command.run);
    const on = (selector: string, action: () => Promise<void>): void =>
      requireEl(row, selector).addEventListener("click", () => void action());
    requireEl<HTMLButtonElement>(row, ".command-item-send").addEventListener("click", (e) => {
      // A double click's second click would run the command again.
      if (e.detail <= 1) void this.send(command);
    });
    on(".command-item-edit", () => this.edit(command));
    on(".command-item-delete", () => this.remove(command));
    return row;
  }

  private async send(command: SavedCommand): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      await this.sendTo(command, this.options.getTargets());
    } finally {
      this.sending = false;
    }
  }

  private async sendTo(command: SavedCommand, targets: CommandTarget[]): Promise<void> {
    if (!(await this.maySend(command, targets))) return;
    const input = makeCommandInput(command);
    for (const target of targets) target.send(input);
    this.options.afterSend();
  }

  /** Several panes are confirmed first. */
  private async maySend(command: SavedCommand, targets: CommandTarget[]): Promise<boolean> {
    if (targets.length === 0) {
      this.options.onInfo(t("commands.noTarget"));
      return false;
    }
    return targets.length === 1 || confirmSend(command, targets);
  }

  private async edit(command: SavedCommand): Promise<void> {
    if (this.editing) return;
    this.editing = true;
    try {
      const edited = await openCommandDialog(command);
      if (edited) await this.save(edited);
    } finally {
      this.editing = false;
    }
  }

  private async save(command: SavedCommand): Promise<void> {
    await this.attempt(async () => {
      const saved = await saveCommand(command);
      this.options.onSuccess(t("commands.saved", { name: saved.name }));
    });
    await this.reload();
  }

  private async remove(command: SavedCommand): Promise<void> {
    const confirmed = await confirm(t("commands.delete.message", { name: command.name }), {
      title: t("commands.delete.title"),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!confirmed) return;
    await this.attempt(async () => {
      await deleteCommand(command.id);
      this.options.onSuccess(t("commands.deleted", { name: command.name }));
    });
    await this.reload();
  }

  private async exportAll(): Promise<void> {
    const path = await pickJsonSavePath("dasshboard-commands.json");
    if (!path) return;
    await this.attempt(async () => {
      this.options.onSuccess(tp("commands.exported", await exportCommands(path)));
    });
  }

  private async importAll(): Promise<void> {
    const path = await pickJsonOpenPath();
    if (!path) return;
    await this.attempt(async () => {
      this.options.onSuccess(tp("commands.imported", await importCommands(path)));
    });
    await this.reload();
  }

  private async attempt(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.options.onError(getErrorMessage(error));
    }
  }
}

function confirmSend(command: SavedCommand, targets: CommandTarget[]): Promise<boolean> {
  const devices = targets.map((target) => target.name).join(", ");
  return confirm(tp("commands.send.message", targets.length, { name: command.name, devices }), {
    title: t("commands.send.title"),
    confirmLabel: t("commands.send.confirm"),
  });
}

/** The first line, marked when more follow. */
function previewOf(text: string): string {
  const [first = "", ...rest] = text.split(/\r\n|\r|\n/);
  return rest.length > 0 ? `${first} …` : first;
}

function emptyMessage(): HTMLElement {
  const empty = document.createElement("p");
  empty.className = "sidebar-empty";
  empty.textContent = t("commands.empty");
  return empty;
}

function headerMarkup(): string {
  return `
    <div class="sidebar-section-title">
      <span class="sidebar-section-title-text">${t("commands.title")}</span>
      <div class="profile-header-actions">
        <button type="button" class="btn btn-icon command-export-btn"
          title="${t("commands.export.title")}" aria-label="${t("common.export")}">${exportIcon}</button>
        <button type="button" class="btn btn-icon command-import-btn"
          title="${t("commands.import.title")}" aria-label="${t("common.import")}">${importIcon}</button>
        <button type="button" class="btn btn-icon command-add-btn"
          title="${t("commands.add")}" aria-label="${t("commands.add")}">${plusIcon}</button>
      </div>
    </div>
  `;
}

function rowMarkup(): string {
  return `
    <button type="button" class="command-item-send" title="${t("commands.item.send")}">
      <span class="command-item-line">
        <span class="command-item-name"></span>
        <span class="command-item-no-enter">${t("commands.item.noEnter")}</span>
      </span>
      <code class="command-item-text"></code>
    </button>
    <div class="profile-item-actions">
      <button type="button" class="btn btn-icon command-item-edit"
        title="${t("commands.item.edit")}" aria-label="${t("commands.item.edit")}">${pencilIcon}</button>
      <button type="button" class="btn btn-icon btn-danger command-item-delete"
        title="${t("commands.item.delete")}" aria-label="${t("commands.item.delete")}">${trashIcon}</button>
    </div>
  `;
}
