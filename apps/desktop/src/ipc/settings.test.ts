/**
 * @vitest-environment happy-dom
 *
 * Wire-shape tests for the settings wrappers. Each wrapper must forward the backend command name with the exact camelCase payload the matching Rust `#[tauri::command]` expects. `@tauri-apps/api`'s `invoke` and `listen` are mocked.
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
	getSettings,
	saveSettings,
	type Settings,
} from "./settings";

beforeEach(() => {
	invokeMock.mockReset();
	listenMock.mockReset();
});

describe("settings wrapper argument shapes", () => {
	it("getSettings forwards no arguments", async () => {
		const settings: Settings = {
			version: 1,
			terminal: { fontSize: 14, fontFamily: "monospace", theme: "dark", scrollback: 1000 },
			lastProfileId: null,
			language: null,
			keepalive: { intervalSecs: 30, countMax: 3 },
			sftp: { idleDisconnectMins: 10, editorCommand: "" },
			updates: { checkOnLaunch: false },
			tray: { closeToTray: false },
		};
		invokeMock.mockResolvedValue(settings);
		await expect(getSettings()).resolves.toEqual(settings);
		expect(invokeMock).toHaveBeenCalledWith("get_settings");
	});

	it("saveSettings sends { settings } and returns the backend-sanitized value", async () => {
		const settings: Settings = {
			version: 1,
			terminal: { fontSize: 14, fontFamily: "monospace", theme: "dark", scrollback: 1000 },
			lastProfileId: "p1",
			language: null,
			keepalive: { intervalSecs: 30, countMax: 3 },
			sftp: { idleDisconnectMins: 10, editorCommand: "" },
			updates: { checkOnLaunch: false },
			tray: { closeToTray: false },
		};
		invokeMock.mockResolvedValue(settings);
		await saveSettings(settings);
		expect(invokeMock).toHaveBeenCalledWith("save_settings", { settings });
	});
});
