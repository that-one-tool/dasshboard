import { invokeChecked } from "./invoke";

/* ----------------------------------------------------------------------------
 * Diagnostic log (backend `app_log.rs`, Logs dialog)
 * -------------------------------------------------------------------------- */

export type LogLevel = "info" | "warn" | "error";

/** Mirrors the backend `LogEntry`. */
export interface LogEntry {
  /** Milliseconds since the Unix epoch. */
  timeMs: number;
  level: LogLevel;
  message: string;
}

/** The kept log lines, oldest first. */
export async function getLogs(): Promise<LogEntry[]> {
  return invokeChecked<LogEntry[]>("get_logs");
}

export async function clearLogs(): Promise<void> {
  await invokeChecked<void>("clear_logs");
}

/** Adds a frontend line. Never pass secrets or terminal data. */
export async function logFrontend(level: LogLevel, message: string): Promise<void> {
  await invokeChecked<void>("log_frontend", { level, message });
}
