/**
 * @vitest-environment happy-dom
 *
 * Wire-shape tests for the update wrappers. Each wrapper must forward the backend command name with the exact camelCase payload the matching Rust `#[tauri::command]` expects. `@tauri-apps/api`'s `invoke` and `listen` are mocked.
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
	checkUpdate,
	downloadUpdate,
	installUpdate,
} from "./updates";

beforeEach(() => {
	invokeMock.mockReset();
	listenMock.mockReset();
});

describe("update wrapper argument shapes", () => {
	it("checkUpdate forwards no arguments and returns the found update", async () => {
		const info = { version: "1.21.0", notes: null, pubDate: "2026-09-29T00:26:49.821Z", canInstall: true, viaFlatpak: false };
		invokeMock.mockResolvedValue(info);
		await expect(checkUpdate()).resolves.toEqual(info);
		expect(invokeMock).toHaveBeenCalledWith("check_update");
	});

	it("checkUpdate normalizes a rejected error", async () => {
		invokeMock.mockRejectedValue({ code: "Update", message: "offline" });
		await expect(checkUpdate()).rejects.toEqual({ code: "Update", message: "offline" });
	});

	it("downloadUpdate sends the confirmed { version }", async () => {
		invokeMock.mockResolvedValue(undefined);
		await downloadUpdate("1.21.0");
		expect(invokeMock).toHaveBeenCalledWith("download_update", { version: "1.21.0" });
	});

	it("installUpdate sends the confirmed { version }", async () => {
		invokeMock.mockResolvedValue(undefined);
		await installUpdate("1.21.0");
		expect(invokeMock).toHaveBeenCalledWith("install_update", { version: "1.21.0" });
	});
});
