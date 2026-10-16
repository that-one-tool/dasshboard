/**
 * @vitest-environment happy-dom
 *
 * Wire-shape tests for the tray wrappers. Each wrapper must forward the backend command name with the exact camelCase payload the matching Rust `#[tauri::command]` expects. `@tauri-apps/api`'s `invoke` and `listen` are mocked.
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
	onLiveSessionCount,
	setTrayLabels,
	getLiveSessionCount,
} from "./tray";

beforeEach(() => {
	invokeMock.mockReset();
	listenMock.mockReset();
});

describe("tray wrapper argument shapes", () => {
	it("getLiveSessionCount forwards no arguments", async () => {
		invokeMock.mockResolvedValue(2);
		await expect(getLiveSessionCount()).resolves.toBe(2);
		expect(invokeMock).toHaveBeenCalledWith("live_session_count");
	});

	it("setTrayLabels sends { labels }", async () => {
		const labels = { connections: "2 live connections", show: "Show DaSSHboard", quit: "Quit" };
		invokeMock.mockResolvedValue(undefined);
		await setTrayLabels(labels);
		expect(invokeMock).toHaveBeenCalledWith("set_tray_labels", { labels });
	});
});

describe("tray event subscriptions", () => {
	it("onLiveSessionCount subscribes to live_session_count and unwraps the count", async () => {
		const unlisten = vi.fn();
		let captured: ((e: { payload: unknown }) => void) | undefined;
		listenMock.mockImplementation((_event: string, cb: (e: { payload: unknown }) => void) => {
			captured = cb;
			return Promise.resolve(unlisten);
		});

		const handler = vi.fn();
		const result = await onLiveSessionCount(handler);

		expect(listenMock).toHaveBeenCalledWith("live_session_count", expect.any(Function));
		expect(result).toBe(unlisten);
		captured?.({ payload: 3 });
		expect(handler).toHaveBeenCalledWith(3);
	});
});
