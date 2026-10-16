/**
 * @vitest-environment happy-dom
 *
 * Wire-shape tests for the workspace wrappers. `@tauri-apps/api`'s `invoke` and `listen` are mocked.
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

import { getWorkspaceState, saveWorkspaceState } from "./workspace";
import { isLocalConfigWriteRecent } from "./invoke";

beforeEach(() => {
	invokeMock.mockReset();
	listenMock.mockReset();
});

describe("workspace wrapper argument shapes", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	const workspace = { tabs: [], activeIndex: 0 };

	it("getWorkspaceState forwards no arguments", async () => {
		invokeMock.mockResolvedValue(workspace);
		await expect(getWorkspaceState()).resolves.toEqual(workspace);
		expect(invokeMock).toHaveBeenCalledWith("get_workspace_state");
	});

	it("saveWorkspaceState sends { workspace } without arming echo suppression (its file isn't watched)", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(Date.UTC(2100, 0, 1));
		invokeMock.mockResolvedValue(undefined);
		await saveWorkspaceState(workspace);
		expect(invokeMock).toHaveBeenCalledWith("save_workspace_state", { workspace });
		expect(isLocalConfigWriteRecent()).toBe(false);
	});
});
