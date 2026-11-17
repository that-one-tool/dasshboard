/**
 * Frontend lines for the backend's diagnostic log: never throwing, and a
 * repeated problem logged at most once per interval.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { ThrottledLog, logToBackend, warnThrottled } from "./frontendLog";

const sentMessages = (): unknown[] =>
	invokeMock.mock.calls.filter((call) => call[0] === "log_frontend").map((call) => (call[1] as { message: string }).message);

beforeEach(() => {
	invokeMock.mockReset();
	invokeMock.mockResolvedValue(undefined);
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("logToBackend", () => {
	it("sends the line", () => {
		logToBackend("info", "reconnecting");
		expect(invokeMock).toHaveBeenCalledWith("log_frontend", { level: "info", message: "reconnecting" });
	});

	it("swallows a failed send", async () => {
		invokeMock.mockRejectedValue(new Error("ipc down"));
		expect(() => logToBackend("warn", "x")).not.toThrow();
		await Promise.resolve();
	});
});

describe("ThrottledLog", () => {
	let now = 0;
	let sent: string[];
	let log: ThrottledLog;

	beforeEach(() => {
		now = 0;
		sent = [];
		log = new ThrottledLog((_level, message) => sent.push(message), () => now, 1_000);
	});

	it("logs the first line of a kind", () => {
		log.log("warn", "slow", "took 3000 ms");
		expect(sent).toEqual(["took 3000 ms"]);
	});

	it("drops a repeat within the interval and counts it on the next line", () => {
		log.log("warn", "slow", "a");
		now = 500;
		log.log("warn", "slow", "b");
		now = 1_000;
		log.log("warn", "slow", "c");
		expect(sent).toEqual(["a", "c (1 similar dropped)"]);
	});

	it("forgets a kind quiet for an interval, so kinds don't pile up", () => {
		log.log("warn", "slow web-1", "a");
		now = 1_000;
		log.log("warn", "slow web-2", "b");
		expect(log.trackedKinds).toBe(1);
	});

	it("keeps a kind's dropped count until its next line", () => {
		log.log("warn", "slow", "a");
		now = 500;
		log.log("warn", "slow", "b");
		now = 5_000;
		log.log("warn", "stall", "x");
		log.log("warn", "slow", "c");
		expect(sent).toEqual(["a", "x", "c (1 similar dropped)"]);
	});

	it("throttles each kind on its own", () => {
		log.log("warn", "slow", "a");
		log.log("warn", "stall", "b");
		expect(sent).toEqual(["a", "b"]);
	});
});

describe("warnThrottled", () => {
	it("warns on the console and logs to the backend", () => {
		warnThrottled("warnThrottled-test", "write_stdin took 3000 ms");
		expect(console.warn).toHaveBeenCalledWith("write_stdin took 3000 ms");
		expect(sentMessages()).toEqual(["write_stdin took 3000 ms"]);
	});
});
