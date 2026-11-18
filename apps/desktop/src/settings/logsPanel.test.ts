/**
 * @vitest-environment happy-dom
 *
 * The Logs dialog's panel: lists the backend's log lines (time, level,
 * message), newest at the bottom, with Refresh, Copy and Clear.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LogEntry } from "../ipc";

vi.mock("../ipc", () => ({
  getLogs: vi.fn(),
  clearLogs: vi.fn(),
}));
const showToastMock = vi.hoisted(() => vi.fn());
vi.mock("../ui/toast", () => ({ showToast: showToastMock }));

import { LogsPanel, clockTime, logsPanelHtml, logsAsText } from "./logsPanel";
import { clearLogs, getLogs } from "../ipc";

const at = (h: number, m: number, s: number, ms: number): number => new Date(2026, 0, 2, h, m, s, ms).getTime();

const entries: LogEntry[] = [
  { timeMs: at(9, 5, 7, 42), level: "info", message: "shell web:22: connecting" },
  { timeMs: at(9, 5, 8, 0), level: "warn", message: "<b>lost</b>" },
];

const writeText = vi.fn(async (_text: string) => {});
let onError: ReturnType<typeof vi.fn<(message: string) => void>>;
let root: HTMLElement;
let panel: LogsPanel;

const q = <T extends HTMLElement>(selector: string): T => root.querySelector<T>(selector) as T;
const rows = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(".logs-entry")];
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.mocked(getLogs).mockReset().mockResolvedValue(entries);
  vi.mocked(clearLogs).mockReset().mockResolvedValue(undefined);
  writeText.mockClear();
  showToastMock.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  document.body.innerHTML = `<div id="root">${logsPanelHtml()}</div>`;
  root = document.querySelector<HTMLElement>("#root") as HTMLElement;
  onError = vi.fn<(message: string) => void>();
  panel = new LogsPanel(root, { onError });
});

describe("clockTime", () => {
  it("is the local time to the millisecond", () => {
    expect(clockTime(at(9, 5, 7, 42))).toBe("09:05:07.042");
  });
});

describe("logsAsText", () => {
  it("is one line per entry: ISO time, level, message", () => {
    const text = logsAsText([{ timeMs: Date.UTC(2026, 0, 2, 9, 5, 7, 42), level: "error", message: "x" }]);
    expect(text).toBe("2026-01-02T09:05:07.042Z ERROR x");
  });
});

describe("LogsPanel", () => {
  it("refresh lists time, level and message, as text, oldest first", async () => {
    await panel.refresh();
    expect(rows()).toHaveLength(2);
    expect(rows()[0]?.textContent).toContain("09:05:07.042");
    expect(rows()[1]?.querySelector(".logs-level")?.textContent).toBe("WARN");
    expect(rows()[1]?.querySelector(".logs-message")?.textContent).toBe("<b>lost</b>");
    expect(rows()[1]?.classList.contains("logs-warn")).toBe(true);
    expect(q(".logs-empty").hidden).toBe(true);
  });

  it("scrolls to the newest line", async () => {
    const list = q(".logs-list");
    Object.defineProperty(list, "scrollHeight", { value: 500, configurable: true });
    await panel.refresh();
    expect(list.scrollTop).toBe(500);
  });

  it("says when there is nothing to show", async () => {
    vi.mocked(getLogs).mockResolvedValue([]);
    await panel.refresh();
    expect(q(".logs-empty").hidden).toBe(false);
  });

  it("the Refresh button reloads the lines", async () => {
    q(".logs-refresh").click();
    await flush();
    expect(getLogs).toHaveBeenCalledOnce();
    expect(rows()).toHaveLength(2);
  });

  it("Copy puts every line on the clipboard", async () => {
    q(".logs-copy").click();
    await flush();
    expect(writeText).toHaveBeenCalledWith(logsAsText(entries));
    expect(showToastMock).toHaveBeenCalledWith("Logs copied to clipboard", "success");
  });

  it("Clear empties the log and the list", async () => {
    await panel.refresh();
    vi.mocked(getLogs).mockResolvedValue([]);
    q(".logs-clear").click();
    await flush();
    expect(clearLogs).toHaveBeenCalledOnce();
    expect(rows()).toHaveLength(0);
  });

  it("reports a failure", async () => {
    vi.mocked(getLogs).mockRejectedValue({ code: "Io", message: "ipc down" });
    await panel.refresh();
    expect(onError).toHaveBeenCalledWith("ipc down");
  });
});
