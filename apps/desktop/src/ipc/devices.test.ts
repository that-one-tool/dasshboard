/**
 * @vitest-environment happy-dom
 *
 * Wire-shape tests for the device wrappers. Each wrapper must forward the backend command name with the exact camelCase payload the matching Rust `#[tauri::command]` expects. `@tauri-apps/api`'s `invoke` and `listen` are mocked.
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
	saveDevice,
	listDevices,
	deleteDevice,
	type Device,
} from "./devices";

beforeEach(() => {
	invokeMock.mockReset();
	listenMock.mockReset();
});

/**
 * F5: `saveDevice`'s tri-state `secret` handling is the exact wire-shape
 * mistake AGENTS.md's "must mirror the Rust serde struct" rule exists to
 * catch. `save_device`'s Rust signature is `secret: Option<String>`
 * (`src-tauri/src/commands/devices.rs`) — serde treats a missing key on an
 * `Option<T>` field as `None`, so the payload must OMIT the key entirely for
 * "leave untouched", never send an explicit `null`/`undefined`.
 */
describe("saveDevice tri-state secret payload", () => {
	const device: Device = {
		id: "dev-1",
		name: "Alpha",
		kind: "ssh",
		host: "10.0.0.1",
		port: 22,
		username: "root",
		auth: { method: "password" },
		forwards: [],
		tunnelAutoStart: false,
		proxyJump: null,
		forwardAgent: false,
		autoReconnect: false,
		tags: [],
		connectSnippet: null,
	};

	it("omits the `secret` key entirely when secret is undefined (leave untouched)", async () => {
		invokeMock.mockResolvedValue(device);
		await saveDevice(device, undefined);

		expect(invokeMock).toHaveBeenCalledWith("save_device", { device });
		const payload = invokeMock.mock.calls[0]?.[1] as Record<string, unknown>;
		expect("secret" in payload).toBe(false);
	});

	it("sends an explicit empty string when secret is '' (overwrite with empty)", async () => {
		invokeMock.mockResolvedValue(device);
		await saveDevice(device, "");

		expect(invokeMock).toHaveBeenCalledWith("save_device", { device, secret: "" });
	});

	it("passes a real secret value through unchanged", async () => {
		invokeMock.mockResolvedValue(device);
		await saveDevice(device, "hunter2");

		expect(invokeMock).toHaveBeenCalledWith("save_device", {
			device,
			secret: "hunter2",
		});
	});

	it("returns the saved device and normalizes a rejected error", async () => {
		invokeMock.mockResolvedValue(device);
		await expect(saveDevice(device)).resolves.toEqual(device);

		invokeMock.mockRejectedValue({ code: "Validation", message: "name required" });
		await expect(saveDevice(device)).rejects.toEqual({
			code: "Validation",
			message: "name required",
		});
	});
});

describe("device wrapper argument shapes", () => {
	it("listDevices forwards no arguments", async () => {
		invokeMock.mockResolvedValue([]);
		await listDevices();
		expect(invokeMock).toHaveBeenCalledWith("list_devices");
	});

	it("deleteDevice sends { deviceId }", async () => {
		invokeMock.mockResolvedValue(undefined);
		await deleteDevice("dev-1");
		expect(invokeMock).toHaveBeenCalledWith("delete_device", { deviceId: "dev-1" });
	});
});
