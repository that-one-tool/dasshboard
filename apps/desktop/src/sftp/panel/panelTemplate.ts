/** The Files panel's chrome, built in the current locale (rebuilt on a
 * language change). Remote-supplied text never goes in here. */

import { t } from "../../i18n";
import {
  chevronLeftIcon,
  disconnectIcon,
  chevronRightIcon,
  copyIcon,
  arrowLeftIcon,
  arrowRightIcon,
  arrowUpIcon,
  reloadIcon,
  uploadIcon,
  uploadFolderIcon,
  folderPlusIcon,
  bookmarkIcon,
} from "../../ui/icons";

function iconAction(action: string, label: string, content: string, extraClass = ""): string {
  return `<button type="button" class="btn btn-icon${extraClass}" data-action="${action}"
    title="${label}" aria-label="${label}">${content}</button>`;
}

function railMarkup(): string {
  return `
  <div class="sftp-rail">
    ${iconAction("expand", t("sftp.expand"), chevronLeftIcon)}
    <span class="sftp-conn-dot" aria-hidden="true"></span>
  </div>`;
}

function headerMarkup(): string {
  return `
    <div class="sftp-panel-header">
      <span class="sftp-panel-title">${t("sftp.panelTitle")}</span>
      <select class="sftp-device-select" aria-label="${t("sftp.selectDevice")}"></select>
      <div class="sftp-panel-header-actions">
        ${iconAction("conn-toggle", t("sftp.disconnect"), disconnectIcon, " sftp-conn-toggle")}
        ${iconAction("collapse", t("sftp.collapse"), chevronRightIcon)}
        ${iconAction("hide", t("common.close"), "&times;")}
      </div>
    </div>`;
}

function toolbarMarkup(): string {
  return `
    <div class="sftp-toolbar">
      <input type="text" class="sftp-path" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="${t("sftp.path.aria")}" title="${t("sftp.path.edit")}" />
      <div class="sftp-toolbar-actions">
        ${iconAction("copy-path", t("sftp.nav.copyPath"), copyIcon)}
        ${iconAction("back", t("sftp.nav.back"), arrowLeftIcon)}
        ${iconAction("forward", t("sftp.nav.forward"), arrowRightIcon)}
        ${iconAction("up", t("sftp.nav.up"), arrowUpIcon)}
        ${iconAction("refresh", t("sftp.nav.refresh"), reloadIcon)}
        ${iconAction("upload", t("sftp.nav.upload"), uploadIcon)}
        ${iconAction("upload-dir", t("sftp.nav.uploadDir"), uploadFolderIcon)}
        ${iconAction("mkdir", t("sftp.nav.mkdir"), folderPlusIcon)}
        ${iconAction("bookmark-toggle", t("sftp.bookmark.add"), bookmarkIcon, " sftp-bookmark-toggle")}
      </div>
    </div>`;
}

function listHeadMarkup(): string {
  return `
    <div class="sftp-listhead">
      <input type="text" class="sftp-filter" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="${t("sftp.filter.aria")}" placeholder="${t("sftp.filter.placeholder")}" />
      <div class="sftp-sortbtns" role="group" aria-label="${t("sftp.sort.aria")}">
        <button type="button" class="btn btn-small" data-action="sort" data-sort="name">${t("sftp.sort.name")}</button>
        <button type="button" class="btn btn-small" data-action="sort" data-sort="size">${t("sftp.sort.size")}</button>
        <button type="button" class="btn btn-small" data-action="sort" data-sort="modified">${t("sftp.sort.modified")}</button>
      </div>
    </div>`;
}

function bulkBarMarkup(): string {
  return `
    <div class="sftp-bulkbar" hidden>
      <label class="sftp-selectall">
        <input type="checkbox" data-action="select-all" aria-label="${t("sftp.selectAll")}" />
        <span class="sftp-sel-count"></span>
      </label>
      <div class="sftp-bulk-actions">
        <button type="button" class="btn btn-small" data-action="bulk-download">${t("sftp.bulk.download")}</button>
        <button type="button" class="btn btn-small" data-action="bulk-cut">${t("sftp.bulk.move")}</button>
        <button type="button" class="btn btn-small sftp-bulk-paste" data-action="bulk-paste" hidden>${t("sftp.bulk.paste")}</button>
        <button type="button" class="btn btn-small btn-danger" data-action="bulk-delete">${t("common.delete")}</button>
        <button type="button" class="btn btn-small" data-action="bulk-clear">${t("sftp.bulk.clear")}</button>
      </div>
    </div>`;
}

export function sftpPanelMarkup(): string {
  return `${railMarkup()}
  <div class="sftp-panel-body">${headerMarkup()}${toolbarMarkup()}
    <div class="sftp-bookmarks" role="list" hidden></div>${listHeadMarkup()}${bulkBarMarkup()}
    <div class="sftp-entries" role="list"></div>
    <div class="sftp-edits" hidden></div>
    <div class="sftp-queue" role="status" aria-live="polite" hidden></div>
    <div class="sftp-status" aria-live="polite"></div>
  </div>`;
}
