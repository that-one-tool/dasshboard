/**
 * @vitest-environment happy-dom
 *
 * Wire-shape tests for the SSH agent wrappers. `@tauri-apps/api`'s `invoke` and `listen` are mocked.
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

import { listAgentIdentities, sshAgentAvailable } from "./agent";

beforeEach(() => {
	invokeMock.mockReset();
	listenMock.mockReset();
});

describe("agent wrapper argument shapes", () => {
	it("sshAgentAvailable forwards no arguments", async () => {
		invokeMock.mockResolvedValue(true);
		await expect(sshAgentAvailable()).resolves.toBe(true);
		expect(invokeMock).toHaveBeenCalledWith("ssh_agent_available");
	});

	it("listAgentIdentities forwards no arguments", async () => {
		invokeMock.mockResolvedValue([]);
		await expect(listAgentIdentities()).resolves.toEqual([]);
		expect(invokeMock).toHaveBeenCalledWith("list_agent_identities");
	});
});
