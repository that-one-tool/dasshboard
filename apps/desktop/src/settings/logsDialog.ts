/**
 * The Logs dialog, opened from the header: the backend's diagnostic log
 * (`LogsPanel`), loaded each time it opens.
 */

import { t } from "../i18n";
import { cancelOnEscape, createDialogRoot, focusAction, showModal } from "../ui/modalDialog";
import { LogsPanel, logsPanelHtml, type LogsPanelOptions } from "./logsPanel";

/** Resolves once the dialog is closed (Close, Escape or the overlay); a no-op
 * while one is already open. */
export function openLogsDialog(options: LogsPanelOptions): Promise<void> {
  if (document.querySelector(".logs-dialog")) return Promise.resolve();
  const root = createDialogRoot("logs-dialog", dialogHtml());
  root.setAttribute("aria-labelledby", "logs-title");
  // showModal's result type can't be undefined, so a dummy `true` stands in
  // and is dropped on close.
  const closed = showModal(root, {
    cancelValue: true,
    actions: {},
    focus: focusAction("cancel"),
    keyResult: cancelOnEscape(true),
  });
  void new LogsPanel(root, options).refresh();
  return closed.then(() => undefined);
}

function dialogHtml(): string {
  return `
    <div class="dialog-overlay"></div>
    <div class="dialog-content logs-content">
      <div class="dialog-header"><h2 id="logs-title" data-i18n="logs.title">${t("logs.title")}</h2></div>
      ${logsPanelHtml()}
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-action="cancel" data-i18n="common.close">${t("common.close")}</button>
      </div>
    </div>`;
}
