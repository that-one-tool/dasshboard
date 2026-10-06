/**
 * The Files panel's "Synced with the server" list: the files open in an
 * external editor, each with its sync status. Clicking a name brings its editor back; the stop button
 * ends the edit. State lives in `editSessions.ts`; this only renders it.
 */

import { t } from "../i18n";
import { closeIcon } from "../ui/icons";
import type { EditEntry, EditStatus } from "./editSessions";

export interface EditListActions {
  onReopen: (editId: string) => void;
  onStop: (editId: string) => void;
}

const STATUS_KEYS = {
  synced: "sftp.edit.status.synced",
  syncing: "sftp.edit.status.syncing",
  pending: "sftp.edit.status.pending",
} as const satisfies Record<EditStatus, string>;

export function renderEditList(
  container: HTMLElement,
  entries: readonly EditEntry[],
  actions: EditListActions,
): void {
  container.hidden = entries.length === 0;
  if (entries.length === 0) {
    container.replaceChildren();
    return;
  }
  const title = document.createElement("div");
  title.className = "sftp-edits-title";
  title.textContent = t("sftp.edit.title");
  // Closing the editor can't be detected (launchers exit at once, editors
  // don't hold the file), so say how an edit ends.
  const hint = document.createElement("div");
  hint.className = "sftp-edits-hint";
  hint.textContent = t("sftp.edit.hint");
  container.replaceChildren(title, ...entries.map((e) => renderRow(e, actions)), hint);
}

function renderRow(entry: EditEntry, actions: EditListActions): HTMLElement {
  const { editId, name, remotePath } = entry.info;
  const row = document.createElement("div");
  row.className = `sftp-edit-row is-${entry.status}`;

  const nameBtn = document.createElement("button");
  nameBtn.type = "button";
  nameBtn.className = "sftp-edit-name";
  nameBtn.textContent = name;
  nameBtn.title = `${remotePath} — ${t("sftp.edit.reopen")}`;
  nameBtn.addEventListener("click", () => actions.onReopen(editId));

  const status = document.createElement("span");
  status.className = "sftp-edit-status";
  status.textContent = t(STATUS_KEYS[entry.status]);

  const stop = document.createElement("button");
  stop.type = "button";
  stop.className = "btn btn-icon btn-small sftp-edit-stop";
  stop.title = t("sftp.edit.stop");
  stop.setAttribute("aria-label", `${t("sftp.edit.stop")}: ${name}`);
  stop.innerHTML = closeIcon;
  stop.addEventListener("click", () => actions.onStop(editId));

  row.append(nameBtn, status, stop);
  return row;
}
