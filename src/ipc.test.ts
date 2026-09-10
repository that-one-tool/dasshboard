/**
 * @vitest-environment happy-dom
 *
 * Unit tests for the typed IPC wrappers in `ipc.ts` — the frontend↔backend
 * seam. Each wrapper must forward the correct backend command name with the
 * exact camelCase payload the matching Rust `#[tauri::command]` expects (a typo
 * here is a silent runtime `undefined` TypeScript can't catch), and event
 * subscriptions must unwrap `e.payload`. `@tauri-apps/api`'s `invoke`, `listen`,
 * and `Channel` are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, listenMock, ChannelMock } = vi.hoisted(() => {
	class ChannelMock {
		onmessage: unknown = null;
	}
	return { invokeMock: vi.fn(), listenMock: vi.fn(), ChannelMock };
});

vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => invokeMock(...args),
	Channel: ChannelMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: (...args: unknown[]) => listenMock(...args),
}));

import {
	exportDevices,
	importDevices,
	exportProfiles,
	importProfiles,
	saveDevice,
	listDevices,
	deleteDevice,
	connect,
	writeStdin,
	resizePty,
	disconnect,
	respondHostKey,
	listKnownHosts,
	forgetHost,
	testConnection,
	saveProfile,
	deleteProfile,
	setDefaultProfile,
	getSettings,
	saveSettings,
	ping,
	listProfiles,
	onSessionStatus,
	onHostKeyPrompt,
	newDataChannel,
	type Device,
	type Settings,
} from "./ipc";

beforeEach(() => {
	invokeMock.mockReset();
	listenMock.mockReset();
});

describe("import/export IPC wrappers", () => {
	const cases: Array<{
		name: string;
		fn: (path: string) => Promise<number>;
		command: string;
	}> = [
		{ name: "exportDevices", fn: exportDevices, command: "export_devices" },
		{ name: "importDevices", fn: importDevices, command: "import_devices" },
		{ name: "exportProfiles", fn: exportProfiles, command: "export_profiles" },
		{ name: "importProfiles", fn: importProfiles, command: "import_profiles" },
	];

	for (const { name, fn, command } of cases) {
		it(`${name} calls ${command} with { path } and returns the count`, async () => {
			invokeMock.mockResolvedValue(3);
			const result = await fn("C:/tmp/file.json");
			expect(invokeMock).toHaveBeenCalledWith(command, {
				path: "C:/tmp/file.json",
			});
			expect(result).toBe(3);
		});
	}

	it("normalizes a rejected AppError from the backend", async () => {
		invokeMock.mockRejectedValue({ code: "Validation", message: "bad kind" });
		await expect(importDevices("C:/tmp/bad.json")).rejects.toEqual({
			code: "Validation",
			message: "bad kind",
		});
	});
});

/**
 * F5: `saveDevice`'s tri-state `secret` handling is the exact wire-shape
 * mistake AGENTS.md's "must mirror the Rust serde struct" rule exists to
 * catch. `save_device`'s Rust signature is `secret: Option<String>`
 * (`src-tauri/src/commands.rs:153-159`) — serde treats a missing key on an
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
		autoReconnect: false,
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

/**
 * F5: argument-shape coverage for the remaining command wrappers. Each must
 * forward the exact command name and the camelCase argument object the
 * matching `#[tauri::command]` in `src-tauri/src/commands.rs` expects.
 */
describe("IPC command wrapper argument shapes", () => {
	it("ping forwards no arguments", async () => {
		invokeMock.mockResolvedValue("1.0.1");
		await expect(ping()).resolves.toBe("1.0.1");
		expect(invokeMock).toHaveBeenCalledWith("ping");
	});

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

	it("connect sends { deviceId, cols, rows, onData }", async () => {
		invokeMock.mockResolvedValue("sess-1");
		const channel = { onmessage: null };
		await connect("dev-1", 80, 24, channel as never);
		expect(invokeMock).toHaveBeenCalledWith("connect", {
			deviceId: "dev-1",
			cols: 80,
			rows: 24,
			onData: channel,
		});
	});

	it("writeStdin sends { sessionId, data }", async () => {
		invokeMock.mockResolvedValue(undefined);
		await writeStdin("sess-1", "ls -la\n");
		expect(invokeMock).toHaveBeenCalledWith("write_stdin", {
			sessionId: "sess-1",
			data: "ls -la\n",
		});
	});

	it("resizePty sends { sessionId, cols, rows }", async () => {
		invokeMock.mockResolvedValue(undefined);
		await resizePty("sess-1", 100, 40);
		expect(invokeMock).toHaveBeenCalledWith("resize_pty", {
			sessionId: "sess-1",
			cols: 100,
			rows: 40,
		});
	});

	it("disconnect sends { sessionId }", async () => {
		invokeMock.mockResolvedValue(undefined);
		await disconnect("sess-1");
		expect(invokeMock).toHaveBeenCalledWith("disconnect", { sessionId: "sess-1" });
	});

	it("respondHostKey sends { promptId, accept }", async () => {
		invokeMock.mockResolvedValue(undefined);
		await respondHostKey("prompt-1", true);
		expect(invokeMock).toHaveBeenCalledWith("respond_host_key", {
			promptId: "prompt-1",
			accept: true,
		});
	});

	it("testConnection sends { deviceId }", async () => {
		invokeMock.mockResolvedValue(undefined);
		await testConnection("dev-1");
		expect(invokeMock).toHaveBeenCalledWith("test_connection", { deviceId: "dev-1" });
	});

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

	it("saveProfile sends { profile }", async () => {
		const profile = { id: "p1", name: "Home", grid: { rows: 1, cols: 1, rowSizes: [1], colSizes: [1] }, panes: [{ deviceId: null }] };
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

	it("getSettings forwards no arguments", async () => {
		const settings: Settings = {
			version: 1,
			terminal: { fontSize: 14, fontFamily: "monospace", theme: "dark" },
			lastProfileId: null,
		};
		invokeMock.mockResolvedValue(settings);
		await expect(getSettings()).resolves.toEqual(settings);
		expect(invokeMock).toHaveBeenCalledWith("get_settings");
	});

	it("saveSettings sends { settings } and returns the backend-sanitized value", async () => {
		const settings: Settings = {
			version: 1,
			terminal: { fontSize: 14, fontFamily: "monospace", theme: "dark" },
			lastProfileId: "p1",
		};
		invokeMock.mockResolvedValue(settings);
		await saveSettings(settings);
		expect(invokeMock).toHaveBeenCalledWith("save_settings", { settings });
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

/**
 * F5: the event subscriptions and the data-channel factory. `onSessionStatus`
 * / `onHostKeyPrompt` wrap `@tauri-apps/api/event`'s `listen`, subscribe to the
 * right event name, and must hand the caller `e.payload` (not the raw event);
 * `newDataChannel` mints a fresh `Channel` per call.
 */
describe("event subscriptions and data channel", () => {
	it("onSessionStatus subscribes to session_status and unwraps the payload", async () => {
		const unlisten = vi.fn();
		let captured: ((e: { payload: unknown }) => void) | undefined;
		listenMock.mockImplementation((_event: string, cb: (e: { payload: unknown }) => void) => {
			captured = cb;
			return Promise.resolve(unlisten);
		});

		const handler = vi.fn();
		const result = await onSessionStatus(handler);

		expect(listenMock).toHaveBeenCalledWith("session_status", expect.any(Function));
		expect(result).toBe(unlisten);

		const payload = { sessionId: "s1", status: "connected" };
		captured?.({ payload });
		expect(handler).toHaveBeenCalledWith(payload);
	});

	it("onHostKeyPrompt subscribes to host_key_prompt and unwraps the payload", async () => {
		const unlisten = vi.fn();
		let captured: ((e: { payload: unknown }) => void) | undefined;
		listenMock.mockImplementation((_event: string, cb: (e: { payload: unknown }) => void) => {
			captured = cb;
			return Promise.resolve(unlisten);
		});

		const handler = vi.fn();
		const result = await onHostKeyPrompt(handler);

		expect(listenMock).toHaveBeenCalledWith("host_key_prompt", expect.any(Function));
		expect(result).toBe(unlisten);

		const payload = { promptId: "pr1", host: "h", port: 22, changed: false };
		captured?.({ payload });
		expect(handler).toHaveBeenCalledWith(payload);
	});

	it("newDataChannel returns a fresh Channel each call", () => {
		const a = newDataChannel();
		const b = newDataChannel();
		expect(a).toBeInstanceOf(ChannelMock);
		expect(b).toBeInstanceOf(ChannelMock);
		expect(a).not.toBe(b);
	});
});
