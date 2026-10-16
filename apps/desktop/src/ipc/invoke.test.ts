/**
 * The invoke helpers every wrapper funnels through: error normalization, and
 * the `invokeChecked` / `invokeMutation` split — only a *successful write*
 * arms the local-write echo suppression that stops this window from
 * auto-reloading its own change. `@tauri-apps/api`'s `invoke` is mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { invokeChecked, invokeMutation, isLocalConfigWriteRecent } from "./invoke";

beforeEach(() => {
	invokeMock.mockReset();
});

describe("invokeChecked", () => {
	it("calls a no-argument command bare", async () => {
		invokeMock.mockResolvedValue("ok");
		await expect(invokeChecked("ping")).resolves.toBe("ok");
		expect(invokeMock).toHaveBeenCalledWith("ping");
		expect(invokeMock.mock.calls[0]).toHaveLength(1);
	});

	it("forwards the arguments", async () => {
		invokeMock.mockResolvedValue(undefined);
		await invokeChecked("disconnect", { sessionId: "s1" });
		expect(invokeMock).toHaveBeenCalledWith("disconnect", { sessionId: "s1" });
	});

	it("passes a backend AppError through, keeping only code and message", async () => {
		invokeMock.mockRejectedValue({ code: "SshAuth", message: "denied", extra: 1 });
		await expect(invokeChecked("connect")).rejects.toStrictEqual({ code: "SshAuth", message: "denied" });
	});

	it.each([
		["a plain string", "ipc broke", "ipc broke"],
		["an Error", new Error("boom"), "Error: boom"],
		["null", null, "null"],
		["an object without a message", { code: "Io" }, "[object Object]"],
		["an object with a non-string code", { code: 5, message: "m" }, "[object Object]"],
	])("wraps %s as an Io error", async (_label, rejection, message) => {
		invokeMock.mockRejectedValue(rejection);
		await expect(invokeChecked("connect")).rejects.toStrictEqual({ code: "Io", message });
	});

	it("wraps a function carrying code and message as an Io error", async () => {
		const rejection = Object.assign(() => {}, { code: "SshAuth", message: "m" });
		invokeMock.mockRejectedValue(rejection);
		await expect(invokeChecked("connect")).rejects.toStrictEqual({ code: "Io", message: String(rejection) });
	});
});

describe("config-write echo suppression", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("a successful mutation arms it for a short while", async () => {
		vi.setSystemTime(1_000_000);
		invokeMock.mockResolvedValue(undefined);
		await invokeMutation("save_profile", {});
		expect(isLocalConfigWriteRecent()).toBe(true);
		vi.setSystemTime(1_000_900);
		expect(isLocalConfigWriteRecent()).toBe(false);
	});

	it("a read does NOT arm it", async () => {
		vi.setSystemTime(2_000_000);
		invokeMock.mockResolvedValue({ defaultProfileId: null, profiles: [] });
		await invokeChecked("list_profiles");
		expect(isLocalConfigWriteRecent()).toBe(false);
	});

	it("a failed mutation does NOT arm it", async () => {
		vi.setSystemTime(3_000_000);
		invokeMock.mockRejectedValue({ code: "Io", message: "disk gone" });
		await expect(invokeMutation("delete_profile", {})).rejects.toBeDefined();
		expect(isLocalConfigWriteRecent()).toBe(false);
	});
});
