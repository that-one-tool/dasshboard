/**
 * @vitest-environment happy-dom
 *
 * Wire-shape tests for the SFTP wrappers. Each wrapper must forward the backend command name with the exact camelCase payload the matching Rust `#[tauri::command]` expects. `@tauri-apps/api`'s `invoke` and `listen` are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
	sftpBookmarkAdd,
	sftpBookmarkRemove,
} from "./sftp";

import { isLocalConfigWriteRecent } from "./invoke";

beforeEach(() => {
	invokeMock.mockReset();
	listenMock.mockReset();
});

describe("bookmark echo suppression", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("a bookmark change arms echo suppression (its file is watched too)", async () => {
		vi.setSystemTime(1_500_000);
		invokeMock.mockResolvedValue(["/etc"]);
		await sftpBookmarkAdd("dev-1", "/etc");
		expect(isLocalConfigWriteRecent()).toBe(true);
		vi.setSystemTime(1_600_000);
		await sftpBookmarkRemove("dev-1", "/etc");
		expect(isLocalConfigWriteRecent()).toBe(true);
	});
});
