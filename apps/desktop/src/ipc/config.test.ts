/**
 * @vitest-environment happy-dom
 *
 * Wire-shape tests for the config wrappers. Each wrapper must forward the backend command name with the exact camelCase payload the matching Rust `#[tauri::command]` expects. `@tauri-apps/api`'s `invoke` and `listen` are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, listenMock } = vi.hoisted(() => {
	return { invokeMock: vi.fn(), listenMock: vi.fn() };
});

vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: (...args: unknown[]) => listenMock(...args),
}));

import {
	ping,
} from "./config";

beforeEach(() => {
	invokeMock.mockReset();
	listenMock.mockReset();
});

describe("config wrapper argument shapes", () => {
	it("ping forwards no arguments", async () => {
		invokeMock.mockResolvedValue("1.0.1");
		await expect(ping()).resolves.toBe("1.0.1");
		expect(invokeMock).toHaveBeenCalledWith("ping");
	});
});
