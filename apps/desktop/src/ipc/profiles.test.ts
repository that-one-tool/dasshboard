/**
 * @vitest-environment happy-dom
 *
 * Wire-shape tests for the profile wrappers. Each wrapper must forward the backend command name with the exact camelCase payload the matching Rust `#[tauri::command]` expects. `@tauri-apps/api`'s `invoke` and `listen` are mocked.
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
	saveProfile,
	deleteProfile,
	setDefaultProfile,
	listProfiles,
} from "./profiles";

import { isLocalConfigWriteRecent } from "./invoke";

beforeEach(() => {
	invokeMock.mockReset();
	listenMock.mockReset();
});

describe("profile wrapper argument shapes", () => {
	it("saveProfile sends { profile }", async () => {
		const profile = {
			id: "p1",
			name: "Home",
			tabs: [{ name: "Home", grid: { rows: 1, cols: 1, rowSizes: [1], colSizes: [1] }, panes: [{ deviceId: null }] }],
		};
		invokeMock.mockResolvedValue(profile);
		await saveProfile(profile);
		expect(invokeMock).toHaveBeenCalledWith("save_profile", { profile });
	});

	it("deleteProfile sends { profileId }", async () => {
		invokeMock.mockResolvedValue(undefined);
		await deleteProfile("p1");
		expect(invokeMock).toHaveBeenCalledWith("delete_profile", { profileId: "p1" });
	});

	it("setDefaultProfile sends { profileId } (including null to clear)", async () => {
		invokeMock.mockResolvedValue(undefined);
		await setDefaultProfile("p1");
		expect(invokeMock).toHaveBeenCalledWith("set_default_profile", { profileId: "p1" });

		invokeMock.mockResolvedValue(undefined);
		await setDefaultProfile(null);
		expect(invokeMock).toHaveBeenCalledWith("set_default_profile", { profileId: null });
	});

	it("listProfiles forwards no arguments and returns the list", async () => {
		const list = { defaultProfileId: "p1", profiles: [] };
		invokeMock.mockResolvedValue(list);
		await expect(listProfiles()).resolves.toEqual(list);
		expect(invokeMock).toHaveBeenCalledWith("list_profiles");
	});

	it("listProfiles normalizes a rejected error", async () => {
		invokeMock.mockRejectedValue({ code: "Io", message: "disk gone" });
		await expect(listProfiles()).rejects.toEqual({ code: "Io", message: "disk gone" });
	});
});

describe("profile save echo suppression", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const profile = {
		id: "p1",
		name: "Home",
		tabs: [{ name: "Home", grid: { rows: 1, cols: 1, rowSizes: [1], colSizes: [1] }, panes: [{ deviceId: null }] }],
	};

	// Each step later than any real-time arm left by the argument-shape tests above.
	it("a successful save arms isLocalConfigWriteRecent(), briefly", async () => {
		vi.setSystemTime(Date.UTC(2100, 0, 1));
		invokeMock.mockResolvedValue(profile);
		await saveProfile(profile);
		expect(isLocalConfigWriteRecent()).toBe(true);
		vi.setSystemTime(Date.UTC(2100, 0, 1) + 900);
		expect(isLocalConfigWriteRecent()).toBe(false);
	});

	it("a successful delete or default change arms it too", async () => {
		invokeMock.mockResolvedValue(undefined);
		vi.setSystemTime(Date.UTC(2099, 11, 1));
		await deleteProfile("p1");
		expect(isLocalConfigWriteRecent()).toBe(true);
		vi.setSystemTime(Date.UTC(2099, 11, 2));
		await setDefaultProfile("p1");
		expect(isLocalConfigWriteRecent()).toBe(true);
	});

	it("listing profiles does NOT arm it", async () => {
		vi.setSystemTime(Date.UTC(2100, 0, 2));
		invokeMock.mockResolvedValue({ defaultProfileId: null, profiles: [] });
		await listProfiles();
		expect(isLocalConfigWriteRecent()).toBe(false);
	});

	it("a failed delete does NOT arm it", async () => {
		vi.setSystemTime(Date.UTC(2100, 0, 3));
		invokeMock.mockRejectedValue({ code: "Io", message: "disk gone" });
		await expect(deleteProfile("p1")).rejects.toBeDefined();
		expect(isLocalConfigWriteRecent()).toBe(false);
	});
});
