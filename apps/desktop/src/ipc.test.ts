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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
	saveTextFile,
	exportProfiles,
	importProfiles,
	saveDevice,
	listDevices,
	deleteDevice,
	connect,
	writeStdin,
	writeStdinBinary,
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
	checkUpdate,
	downloadUpdate,
	installUpdate,
	saveSettings,
	ping,
	listProfiles,
	onSessionStatus,
	onHostKeyPrompt,
	onLiveSessionCount,
	setTrayLabels,
	getLiveSessionCount,
	newDataChannel,
	isLocalConfigWriteRecent,
	sftpEditOpen,
	sftpEditLaunch,
	sftpEditCheck,
	sftpEditUpload,
	sftpEditDiscard,
	sftpEditClose,
	sftpEditableSize,
	sftpBookmarkAdd,
	sftpBookmarkRemove,
	onSftpEditChanged,
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

describe("saveTextFile", () => {
	it("calls save_text_file with { path, contents }", async () => {
		invokeMock.mockResolvedValue(undefined);
		await saveTextFile("/home/me/out.txt", "$ ls\n");
		expect(invokeMock).toHaveBeenCalledWith("save_text_file", {
			path: "/home/me/out.txt",
			contents: "$ ls\n",
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

	it("connect sends { sessionId, deviceId, cols, rows, onData }", async () => {
		invokeMock.mockResolvedValue("sess-1");
		const channel = { onmessage: null };
		await connect("sess-1", "dev-1", 80, 24, channel as never);
		expect(invokeMock).toHaveBeenCalledWith("connect", {
			sessionId: "sess-1",
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

	it("writeStdinBinary marks the data as binary", async () => {
		invokeMock.mockResolvedValue(undefined);
		await writeStdinBinary("sess-1", "\x1b[M \xff!");
		expect(invokeMock).toHaveBeenCalledWith("write_stdin", {
			sessionId: "sess-1",
			data: "\x1b[M \xff!",
			binary: true,
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

/**
 * The `invokeChecked` / `invokeMutation` split (see ipc.ts): only a *successful
 * write* command arms the local-write echo suppression that stops this window
 * from auto-reloading its own change. A read command, and a write that failed,
 * must leave it un-armed. Uses fake timers so the 900 ms echo window is
 * controlled deterministically (and so a prior test's arm can't bleed in).
 */
describe("SFTP edit-in-place wrappers", () => {
	it("sftpEditOpen sends { deviceId, remotePath } and returns the edit", async () => {
		const info = { editId: "e1", deviceId: "d1", remotePath: "/etc/a.conf", name: "a.conf" };
		invokeMock.mockResolvedValue(info);
		await expect(sftpEditOpen("d1", "/etc/a.conf")).resolves.toEqual(info);
		expect(invokeMock).toHaveBeenCalledWith("sftp_edit_open", {
			deviceId: "d1",
			remotePath: "/etc/a.conf",
		});
	});

	it("sftpEditUpload sends { editId, overwrite } and returns the outcome", async () => {
		invokeMock.mockResolvedValue("conflict");
		await expect(sftpEditUpload("e1", false)).resolves.toBe("conflict");
		expect(invokeMock).toHaveBeenCalledWith("sftp_edit_upload", { editId: "e1", overwrite: false });
	});

	it("sftpEditableSize sends { deviceId, path } and returns the size", async () => {
		invokeMock.mockResolvedValue(42);
		await expect(sftpEditableSize("d1", "/etc/a.conf")).resolves.toBe(42);
		expect(invokeMock).toHaveBeenCalledWith("sftp_editable_size", { deviceId: "d1", path: "/etc/a.conf" });
	});

	it("sftpEditCheck returns the check result", async () => {
		invokeMock.mockResolvedValue("clean");
		await expect(sftpEditCheck("e1")).resolves.toBe("clean");
		expect(invokeMock).toHaveBeenCalledWith("sftp_edit_check", { editId: "e1" });
	});

	const editIdOnly: Array<[string, (id: string) => Promise<void>, string]> = [
		["sftpEditLaunch", sftpEditLaunch, "sftp_edit_launch"],
		["sftpEditDiscard", sftpEditDiscard, "sftp_edit_discard"],
		["sftpEditClose", sftpEditClose, "sftp_edit_close"],
	];
	for (const [name, fn, command] of editIdOnly) {
		it(`${name} calls ${command} with { editId }`, async () => {
			invokeMock.mockResolvedValue(undefined);
			await fn("e1");
			expect(invokeMock).toHaveBeenCalledWith(command, { editId: "e1" });
		});
	}

	it("onSftpEditChanged subscribes to sftp_edit_changed and unwraps the edit id", async () => {
		let captured: ((e: { payload: unknown }) => void) | undefined;
		listenMock.mockImplementation((_event: string, cb: (e: { payload: unknown }) => void) => {
			captured = cb;
			return Promise.resolve(vi.fn());
		});
		const handler = vi.fn();

		await onSftpEditChanged(handler);

		expect(listenMock).toHaveBeenCalledWith("sftp_edit_changed", expect.any(Function));
		captured?.({ payload: { editId: "e1" } });
		expect(handler).toHaveBeenCalledWith("e1");
	});
});

describe("config-write echo suppression (invokeMutation vs invokeChecked)", () => {
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

	it("a successful mutation arms isLocalConfigWriteRecent()", async () => {
		vi.setSystemTime(1_000_000);
		invokeMock.mockResolvedValue(profile);
		await saveProfile(profile);
		expect(isLocalConfigWriteRecent()).toBe(true);
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

	it("a read wrapper does NOT arm echo suppression", async () => {
		// Advance well past any prior write's 900 ms echo window first.
		vi.setSystemTime(2_000_000);
		invokeMock.mockResolvedValue({ defaultProfileId: null, profiles: [] });
		await listProfiles();
		expect(isLocalConfigWriteRecent()).toBe(false);
	});

	it("a failed mutation does NOT arm echo suppression", async () => {
		vi.setSystemTime(3_000_000);
		invokeMock.mockRejectedValue({ code: "Io", message: "disk gone" });
		await expect(deleteProfile("p1")).rejects.toBeDefined();
		expect(isLocalConfigWriteRecent()).toBe(false);
	});

	it("respondHostKey arms only when the host key is accepted", async () => {
		vi.setSystemTime(4_000_000);
		invokeMock.mockResolvedValue(undefined);
		await respondHostKey("pr1", false);
		expect(isLocalConfigWriteRecent()).toBe(false);

		vi.setSystemTime(5_000_000);
		await respondHostKey("pr1", true);
		expect(isLocalConfigWriteRecent()).toBe(true);
	});
});
