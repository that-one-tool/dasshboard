/** The Files panel's single-entry operations on the current directory: new
 * folder, rename, delete, permissions (chmod), and edit in place. Each
 * re-lists the directory once done. */

import { sftpChmod, sftpMkdir, sftpRemove, sftpRename, type SftpEntry } from "../../ipc";
import { t } from "../../i18n";
import { choosePermissions, confirm, prompt } from "../../ui/confirm";
import type { EditSessions } from "../editSessions";
import { joinRemote } from "../sftpFormat";
import type { DirectoryBrowser, RemotePlace } from "./directoryBrowser";
import type { PanelFeedback } from "./panelFeedback";

export interface OperationDeps {
  browser: DirectoryBrowser;
  feedback: PanelFeedback;
  edits: EditSessions;
  clearHover: () => void;
}

type DirOperation = (deviceId: string, dir: string) => Promise<unknown>;

export class EntryOperations {
  constructor(private readonly deps: OperationDeps) {}

  async mkdir(): Promise<void> {
    const place = this.deps.browser.place();
    if (place === null) return;
    const name = trimmedAnswer(await prompt(t("sftp.mkdir.title"), t("sftp.mkdir.placeholder")));
    if (name !== "") await this.inPlace(place, (deviceId, dir) => sftpMkdir(deviceId, joinRemote(dir, name)));
  }

  async rename(entry: SftpEntry): Promise<void> {
    const place = this.begin();
    if (place === null) return;
    const next = trimmedAnswer(await prompt(t("sftp.rename.title"), t("sftp.rename.placeholder"), entry.name));
    if (isUnchanged(next, entry)) return;
    await this.inPlace(place, (deviceId, dir) =>
      sftpRename(deviceId, joinRemote(dir, entry.name), joinRemote(dir, next)),
    );
  }

  async delete(entry: SftpEntry): Promise<void> {
    const place = this.begin();
    if (place === null) return;
    const confirmed = await confirm(deleteMessage(entry), {
      title: t("sftp.delete.title"),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (confirmed) await this.inPlace(place, (deviceId, dir) => removeEntry(deviceId, dir, entry));
  }

  /** Open the chmod dialog for an entry and apply the chosen mode. */
  async permissions(entry: SftpEntry): Promise<void> {
    const place = this.begin();
    if (place === null) return;
    const mode = await choosePermissions(entry.name, modeOf(entry));
    if (mode === null) return; // cancelled
    const changed = t("sftp.perms.changed", { name: entry.name });
    await this.inPlace(place, (deviceId, dir) => sftpChmod(deviceId, joinRemote(dir, entry.name), mode), changed);
  }

  /** Open a remote file in the external editor (edit in place). */
  async edit(entry: SftpEntry): Promise<void> {
    const place = this.begin();
    if (place === null) return;
    await this.deps.edits.open(place.deviceId, joinRemote(place.dir, entry.name), entry.name);
  }

  /** Where the entry action runs, or `null` when not connected; clears the
   * row hover before a dialog opens. */
  private begin(): RemotePlace | null {
    const place = this.deps.browser.place();
    if (place !== null) this.deps.clearHover();
    return place;
  }

  /** Run `operation` in `place` (captured before the dialog), re-list it and
   * say so; nothing when another device or directory took over meanwhile. A
   * failure is reported. */
  private async inPlace(place: RemotePlace, operation: DirOperation, successMessage = ""): Promise<void> {
    if (!this.deps.browser.isAt(place)) return;
    await this.deps.feedback.attempt(async () => {
      await operation(place.deviceId, place.dir);
      await this.deps.browser.reload();
      if (successMessage) this.deps.feedback.success(successMessage);
    });
  }
}

/** Remove one entry; a folder goes recursively. */
export function removeEntry(deviceId: string, dir: string, entry: SftpEntry): Promise<void> {
  const isDir = entry.kind === "dir";
  return sftpRemove(deviceId, joinRemote(dir, entry.name), isDir, isDir);
}

function trimmedAnswer(answer: string | null): string {
  return answer === null ? "" : answer.trim();
}

/** No new name: empty, or the one it has. */
function isUnchanged(next: string, entry: SftpEntry): boolean {
  return next === "" || next === entry.name;
}

function modeOf(entry: SftpEntry): number {
  return entry.mode ?? 0;
}

function deleteMessage(entry: SftpEntry): string {
  const key = entry.kind === "dir" ? "sftp.delete.messageDir" : "sftp.delete.message";
  return t(key, { name: entry.name });
}
