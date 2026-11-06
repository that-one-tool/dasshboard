/**
 * @vitest-environment happy-dom
 *
 * Wire-shape tests for the session wrappers. Each wrapper must forward the backend command name with the exact camelCase payload the matching Rust `#[tauri::command]` expects. `@tauri-apps/api`'s `invoke` and `listen` are mocked.
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
	connect,
	readOutput,
	writeStdin,
	writeStdinBinary,
	resizePty,
	disconnect,
	respondHostKey,
	testConnection,
	onSessionStatus,
	onHostKeyPrompt,
	respondAuthPrompt,
	onAuthPrompt,
	onAuthPromptClosed,
} from "./sessions";

import { isLocalConfigWriteRecent } from "./invoke";
import type { Device } from "./devices";

const testedDevice: Device = {
	id: "",
	name: "NAS",
	kind: "ssh",
	host: "10.0.0.1",
	port: 22,
	username: "root",
	auth: { method: "password" },
	forwards: [],
	tunnelAutoStart: false,
	proxyJump: null,
	forwardAgent: false,
	x11Forwarding: "off",
	autoReconnect: false,
	tags: [],
	connectSnippet: null,
};

beforeEach(() => {
	invokeMock.mockReset();
	listenMock.mockReset();
});

describe("session wrapper argument shapes", () => {
	it("connect sends { sessionId, deviceId, cols, rows }", async () => {
		invokeMock.mockResolvedValue("sess-1");
		await connect("sess-1", "dev-1", 80, 24);
		expect(invokeMock).toHaveBeenCalledWith("connect", {
			sessionId: "sess-1",
			deviceId: "dev-1",
			cols: 80,
			rows: 24,
		});
	});

	it("connect sends recordTo when the pane records", async () => {
		invokeMock.mockResolvedValue("sess-1");
		await connect("sess-1", "dev-1", 80, 24, "/home/me/rec.log");
		expect(invokeMock).toHaveBeenCalledWith("connect", {
			sessionId: "sess-1",
			deviceId: "dev-1",
			cols: 80,
			rows: 24,
			recordTo: "/home/me/rec.log",
		});
	});

	it("readOutput sends { sessionId, from } and decodes the reply", async () => {
		// start = 258 (big-endian u64), end flag 0, then the bytes "hi".
		const wire = new Uint8Array([0, 0, 0, 0, 0, 0, 1, 2, 0, 104, 105]);
		invokeMock.mockResolvedValue(wire.buffer);
		const chunk = await readOutput("sess-1", 256);
		expect(invokeMock).toHaveBeenCalledWith("read_output", { sessionId: "sess-1", from: 256 });
		expect(chunk.start).toBe(258);
		expect(chunk.end).toBe(false);
		expect([...chunk.bytes]).toEqual([104, 105]);
	});

	it("readOutput decodes a reply that arrives as plain numbers (IPC postMessage fallback)", async () => {
		// After one failed IPC fetch Tauri falls back to postMessage, which hands
		// a binary reply over as a JSON array of bytes, not an ArrayBuffer.
		invokeMock.mockResolvedValue([0, 0, 0, 0, 0, 0, 0, 5, 0, 104, 105]);
		const chunk = await readOutput("sess-1", 5);
		expect(chunk.start).toBe(5);
		expect(chunk.end).toBe(false);
		expect([...chunk.bytes]).toEqual([104, 105]);
	});

	it("readOutput reports a session's end", async () => {
		invokeMock.mockResolvedValue(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 7, 1]).buffer);
		const chunk = await readOutput("sess-1", 7);
		expect(chunk).toMatchObject({ start: 7, end: true });
		expect(chunk.bytes).toHaveLength(0);
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

	it("testConnection sends the device and a typed secret", async () => {
		invokeMock.mockResolvedValue(undefined);
		await testConnection(testedDevice, "pw");
		expect(invokeMock).toHaveBeenCalledWith("test_connection", { device: testedDevice, secret: "pw" });
	});

	// `secret: Option<String>` on the Rust side: omitted, never `null`.
	it("testConnection omits the secret key when none was typed", async () => {
		invokeMock.mockResolvedValue(undefined);
		await testConnection(testedDevice);
		expect(invokeMock).toHaveBeenCalledWith("test_connection", { device: testedDevice });
	});
});

describe("session event subscriptions", () => {
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
});

describe("keyboard-interactive prompts", () => {
	beforeEach(() => {
		invokeMock.mockReset();
		listenMock.mockReset();
	});

	it("respondAuthPrompt sends the answers", async () => {
		invokeMock.mockResolvedValue(undefined);
		await respondAuthPrompt("a1", ["123456"]);
		expect(invokeMock).toHaveBeenCalledWith("respond_auth_prompt", {
			promptId: "a1",
			answers: ["123456"],
		});
	});

	it("respondAuthPrompt sends null answers to cancel", async () => {
		invokeMock.mockResolvedValue(undefined);
		await respondAuthPrompt("a1", null);
		expect(invokeMock).toHaveBeenCalledWith("respond_auth_prompt", {
			promptId: "a1",
			answers: null,
		});
	});

	it("onAuthPrompt and onAuthPromptClosed unwrap their payloads", async () => {
		const callbacks = new Map<string, (e: { payload: unknown }) => void>();
		listenMock.mockImplementation((event: string, cb: (e: { payload: unknown }) => void) => {
			callbacks.set(event, cb);
			return Promise.resolve(vi.fn());
		});
		const onPrompt = vi.fn();
		const onClosed = vi.fn();
		await onAuthPrompt(onPrompt);
		await onAuthPromptClosed(onClosed);

		const payload = { promptId: "a1", host: "h", port: 22, username: "u", name: "", instructions: "", fields: [] };
		callbacks.get("auth_prompt")?.({ payload });
		callbacks.get("auth_prompt_closed")?.({ payload: { promptId: "a1" } });

		expect(onPrompt).toHaveBeenCalledWith(payload);
		expect(onClosed).toHaveBeenCalledWith("a1");
	});
});

describe("host-key answer echo suppression", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("respondHostKey arms only when the host key is accepted", async () => {
		// Later than any real-time arm left by the argument-shape tests above.
		vi.setSystemTime(Date.UTC(2100, 0, 1));
		invokeMock.mockResolvedValue(undefined);
		await respondHostKey("pr1", false);
		expect(isLocalConfigWriteRecent()).toBe(false);

		vi.setSystemTime(Date.UTC(2100, 0, 2));
		await respondHostKey("pr1", true);
		expect(isLocalConfigWriteRecent()).toBe(true);
	});
});
