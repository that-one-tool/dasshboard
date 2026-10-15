/** One row of the Files panel's listing. Built with DOM APIs, so a
 * remote-supplied name goes in as text, never markup. */

import type { SftpEntry } from "../../ipc";
import { t } from "../../i18n";
import { downloadIcon, fileEditIcon, lockIcon, pencilIcon, trashIcon } from "../../ui/icons";
import { formatMode, formatMtime, formatSize } from "../sftpFormat";

export interface EntryRowActions {
  /** While the panel is busy, clicks on the row do nothing. */
  isBusy: () => boolean;
  onCheck: (index: number, shift: boolean) => void;
  /** The name was clicked: a folder opens, a file downloads. */
  onOpen: (entry: SftpEntry) => void;
  onDownload: (entry: SftpEntry) => void;
  onEdit: (entry: SftpEntry) => void;
  onRename: (entry: SftpEntry) => void;
  onPermissions: (entry: SftpEntry) => void;
  onDelete: (entry: SftpEntry) => void;
}

const KIND_ICONS: Record<SftpEntry["kind"], string> = { dir: "📁", symlink: "🔗", file: "📄" };

export function renderEntryRow(
  entry: SftpEntry,
  index: number,
  checked: boolean,
  actions: EntryRowActions,
): HTMLElement {
  const row = rowElement(entry);
  row.append(
    checkbox(entry, index, checked, actions),
    kindIcon(entry),
    nameButton(entry, actions),
    meta(entry),
    actionButtons(entry, actions),
  );
  return row;
}

function rowElement(entry: SftpEntry): HTMLElement {
  const row = document.createElement("div");
  row.className = `sftp-entry is-${entry.kind}`;
  row.setAttribute("role", "listitem");
  // Hover is tracked in script (not CSS `:hover`): a native OS dialog opens
  // without firing `mouseleave`, which would leave the action buttons stuck on.
  row.addEventListener("mouseenter", () => row.classList.add("hovering"));
  row.addEventListener("mouseleave", () => row.classList.remove("hovering"));
  return row;
}

function kindIcon(entry: SftpEntry): HTMLElement {
  const icon = document.createElement("span");
  icon.className = "sftp-entry-icon";
  icon.textContent = KIND_ICONS[entry.kind] ?? KIND_ICONS.file;
  return icon;
}

function checkbox(entry: SftpEntry, index: number, checked: boolean, actions: EntryRowActions): HTMLInputElement {
  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "sftp-entry-check";
  check.checked = checked;
  check.setAttribute("aria-label", entry.name);
  check.addEventListener("click", (e) => actions.onCheck(index, e.shiftKey));
  return check;
}

function nameButton(entry: SftpEntry, actions: EntryRowActions): HTMLButtonElement {
  const name = document.createElement("button");
  name.type = "button";
  name.className = "sftp-entry-name";
  name.textContent = entry.name;
  name.title = entry.kind === "dir" ? t("sftp.entry.openFolder") : t("sftp.entry.downloadFile");
  name.addEventListener("click", () => {
    if (!actions.isBusy()) actions.onOpen(entry);
  });
  return name;
}

function meta(entry: SftpEntry): HTMLElement {
  const el = document.createElement("span");
  el.className = "sftp-entry-meta";
  const size = entry.kind === "dir" ? "" : formatSize(entry.size);
  el.textContent = [formatMode(entry.mode), size, formatMtime(entry.modified)].filter(Boolean).join("  ·  ");
  return el;
}

function actionButtons(entry: SftpEntry, actions: EntryRowActions): HTMLElement {
  const el = document.createElement("span");
  el.className = "sftp-entry-actions";
  const button = (icon: string, label: string, handler: (entry: SftpEntry) => void, danger = false) =>
    iconButton(icon, label, () => handler(entry), actions, danger);
  el.appendChild(button(downloadIcon, t("sftp.entry.download"), actions.onDownload));
  if (entry.kind !== "dir") el.appendChild(button(fileEditIcon, t("sftp.entry.edit"), actions.onEdit));
  el.appendChild(button(pencilIcon, t("sftp.entry.rename"), actions.onRename));
  if (canChmod(entry)) el.appendChild(button(lockIcon, t("sftp.entry.permissions"), actions.onPermissions));
  el.appendChild(button(trashIcon, t("sftp.entry.delete"), actions.onDelete, true));
  return el;
}

/** SETSTAT follows a symlink to its target (SFTP v3 has no LSETSTAT), so a
 * symlink row would silently rewrite the target's mode; and a server that
 * reported no mode can't be chmod'd meaningfully. */
function canChmod(entry: SftpEntry): boolean {
  return entry.kind !== "symlink" && entry.mode !== undefined;
}

function iconButton(
  html: string,
  label: string,
  onClick: () => void,
  actions: EntryRowActions,
  danger: boolean,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `btn btn-icon btn-small${danger ? " btn-danger" : ""}`;
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.innerHTML = html;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!actions.isBusy()) onClick();
  });
  return btn;
}
