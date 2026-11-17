/**
 * Wire-shape tests for the diagnostic log wrappers (backend `commands/logs.rs`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { clearLogs, getLogs, logFrontend } from "./logs";

beforeEach(() => {
	invokeMock.mockReset();
});

describe("log wrappers", () => {
	it("getLogs returns the backend entries", async () => {
		const entries = [{ timeMs: 1, level: "warn", message: "lost" }];
		invokeMock.mockResolvedValue(entries);
		await expect(getLogs()).resolves.toEqual(entries);
		expect(invokeMock).toHaveBeenCalledWith("get_logs");
	});

	it("clearLogs forwards no arguments", async () => {
		invokeMock.mockResolvedValue(undefined);
		await clearLogs();
		expect(invokeMock).toHaveBeenCalledWith("clear_logs");
	});

	it("logFrontend sends { level, message }", async () => {
		invokeMock.mockResolvedValue(undefined);
		await logFrontend("error", "stalled");
		expect(invokeMock).toHaveBeenCalledWith("log_frontend", { level: "error", message: "stalled" });
	});
});
