/**
 * @vitest-environment happy-dom
 *
 * Wire-shape tests for the known-hosts wrappers. Each wrapper must forward the backend command name with the exact camelCase payload the matching Rust `#[tauri::command]` expects. `@tauri-apps/api`'s `invoke` and `listen` are mocked.
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
	listKnownHosts,
	forgetHost,
} from "./knownHosts";

beforeEach(() => {
	invokeMock.mockReset();
	listenMock.mockReset();
});

describe("known-hosts wrapper argument shapes", () => {
	it("listKnownHosts calls list_known_hosts and returns the rows", async () => {
		const rows = [{ id: "10.0.0.1:22", keyType: "ssh-ed25519", fingerprint: "SHA256:abc" }];
		invokeMock.mockResolvedValue(rows);
		await expect(listKnownHosts()).resolves.toEqual(rows);
		expect(invokeMock).toHaveBeenCalledWith("list_known_hosts");
	});

	it("forgetHost sends { id }", async () => {
		invokeMock.mockResolvedValue(undefined);
		await forgetHost("10.0.0.1:22");
		expect(invokeMock).toHaveBeenCalledWith("forget_host", { id: "10.0.0.1:22" });
	});
});
