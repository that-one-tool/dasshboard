/**
 * The Settings dialog's Logs tab: the backend's diagnostic log (connection
 * events, slow calls, stalls), newest at the bottom, with Refresh, Copy and
 * Clear. Messages are set as text, never HTML: some come from servers.
 */

import { clearLogs, getLogs, type LogEntry } from "../ipc";
import { t } from "../i18n";
import type { MessageKey } from "../i18n/en";
import { getErrorMessage } from "../ui/errorMessage";
import { showToast } from "../ui/toast";

export interface LogsPanelOptions {
  onError: (message: string) => void;
}

export function logsTabHtml(): string {
  return `<button type="button" class="settings-tab" role="tab" id="settings-tab-logs"
    data-tab="logs" aria-controls="settings-panel-logs" aria-selected="false"
    data-i18n="settings.tab.logs" tabindex="-1">${t("settings.tab.logs")}</button>`;
}

export function logsPanelHtml(): string {
  return `<div class="settings-panel settings-logs" role="tabpanel" id="settings-panel-logs"
    data-panel="logs" aria-labelledby="settings-tab-logs" hidden>
    <p class="form-hint" data-i18n="settings.logs.hint">${t("settings.logs.hint")}</p>
    <div class="logs-actions">
      ${actionButton("logs-refresh", "settings.logs.refresh")}
      ${actionButton("logs-copy", "settings.logs.copy")}
      ${actionButton("logs-clear", "settings.logs.clear")}
    </div>
    <ol class="logs-list" tabindex="0" data-i18n-aria="settings.logs.aria" aria-label="${t("settings.logs.aria")}"></ol>
    <p class="logs-empty form-hint" data-i18n="settings.logs.empty" hidden>${t("settings.logs.empty")}</p>
  </div>`;
}

function actionButton(className: string, key: MessageKey): string {
  return `<button type="button" class="btn btn-secondary ${className}" data-i18n="${key}">${t(key)}</button>`;
}

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

/** `HH:MM:SS.mmm`, local time. */
export function clockTime(timeMs: number): string {
  const date = new Date(timeMs);
  const clock = [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => pad(part)).join(":");
  return `${clock}.${pad(date.getMilliseconds(), 3)}`;
}

/** The lines as plain text (UTC ISO times), for a bug report. */
export function logsAsText(entries: LogEntry[]): string {
  return entries.map((e) => `${new Date(e.timeMs).toISOString()} ${e.level.toUpperCase()} ${e.message}`).join("\n");
}

export class LogsPanel {
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly options: LogsPanelOptions,
  ) {
    this.list = root.querySelector<HTMLElement>(".logs-list") as HTMLElement;
    this.empty = root.querySelector<HTMLElement>(".logs-empty") as HTMLElement;
    this.onClick(".logs-refresh", () => this.refresh());
    this.onClick(".logs-copy", () => this.copy());
    this.onClick(".logs-clear", () => this.clear());
  }

  async refresh(): Promise<void> {
    await this.guard(async () => this.render(await getLogs()));
  }

  private onClick(selector: string, action: () => Promise<void>): void {
    this.root.querySelector(selector)?.addEventListener("click", () => void action());
  }

  private async copy(): Promise<void> {
    await this.guard(async () => {
      const entries = await getLogs();
      this.render(entries);
      await navigator.clipboard.writeText(logsAsText(entries));
      showToast(t("settings.logs.copied"), "success");
    });
  }

  private async clear(): Promise<void> {
    await this.guard(async () => {
      await clearLogs();
      this.render(await getLogs());
    });
  }

  private async guard(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (err) {
      this.options.onError(getErrorMessage(err));
    }
  }

  private render(entries: LogEntry[]): void {
    this.list.replaceChildren(...entries.map(entryRow));
    this.empty.hidden = entries.length > 0;
    this.list.scrollTop = this.list.scrollHeight;
  }
}

function entryRow(entry: LogEntry): HTMLElement {
  const row = document.createElement("li");
  row.className = `logs-entry logs-${entry.level}`;
  row.append(
    textSpan("logs-time", clockTime(entry.timeMs)),
    textSpan("logs-level", entry.level.toUpperCase()),
    textSpan("logs-message", entry.message),
  );
  return row;
}

function textSpan(className: string, text: string): HTMLElement {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}
