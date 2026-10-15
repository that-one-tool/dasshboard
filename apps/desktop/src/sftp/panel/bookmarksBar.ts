/** The Files panel's bookmark chips and the toolbar's bookmark toggle. Paths
 * are remote-supplied, so they go in as text, never markup. */

import { t } from "../../i18n";
import { bookmarkFilledIcon, bookmarkIcon } from "../../ui/icons";

/** A chip's label: the path's last segment (root ⇒ `/`). */
export function bookmarkLabel(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed === "" ? "/" : trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

export function renderBookmarks(el: HTMLElement, paths: readonly string[], cwd: string): void {
  el.hidden = paths.length === 0;
  el.replaceChildren(...paths.map((path) => bookmarkChip(path, path === cwd)));
}

export function renderBookmarkToggle(btn: HTMLElement, marked: boolean): void {
  btn.innerHTML = marked ? bookmarkFilledIcon : bookmarkIcon;
  const label = marked ? t("sftp.bookmark.remove") : t("sftp.bookmark.add");
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.classList.toggle("is-marked", marked);
}

function bookmarkChip(path: string, current: boolean): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "sftp-bookmark";
  chip.setAttribute("role", "listitem");
  chip.classList.toggle("is-current", current);
  const go = chipButton("sftp-bookmark-go", "bookmark-go", path);
  go.textContent = bookmarkLabel(path);
  go.title = path;
  const remove = chipButton("sftp-bookmark-del", "bookmark-del", path);
  remove.title = t("sftp.bookmark.remove");
  remove.setAttribute("aria-label", t("sftp.bookmark.remove"));
  remove.textContent = "×";
  chip.append(go, remove);
  return chip;
}

function chipButton(className: string, action: string, path: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.dataset.action = action;
  btn.dataset.path = path;
  return btn;
}
