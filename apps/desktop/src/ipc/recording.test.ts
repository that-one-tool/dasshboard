/**
 * Wire-shape tests for the session recording wrappers.
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

import { onRecordingFailed, startRecording, stopRecording } from "./recording";

beforeEach(() => {
	invokeMock.mockReset();
	listenMock.mockReset();
});

describe("recording commands", () => {
	it("startRecording sends { sessionId, path }", async () => {
		invokeMock.mockResolvedValue(undefined);
		await startRecording("sess-1", "/home/me/rec.log");
		expect(invokeMock).toHaveBeenCalledWith("start_recording", {
			sessionId: "sess-1",
			path: "/home/me/rec.log",
		});
	});

	it("stopRecording sends { sessionId }", async () => {
		invokeMock.mockResolvedValue(undefined);
		await stopRecording("sess-1");
		expect(invokeMock).toHaveBeenCalledWith("stop_recording", { sessionId: "sess-1" });
	});
});

describe("onRecordingFailed", () => {
	it("subscribes to recording_failed and unwraps the payload", async () => {
		const unlisten = vi.fn();
		let captured: ((e: { payload: unknown }) => void) | undefined;
		listenMock.mockImplementation((_event: string, cb: (e: { payload: unknown }) => void) => {
			captured = cb;
			return Promise.resolve(unlisten);
		});
		const handler = vi.fn();

		expect(await onRecordingFailed(handler)).toBe(unlisten);
		expect(listenMock).toHaveBeenCalledWith("recording_failed", expect.any(Function));
		captured?.({ payload: { sessionId: "sess-1", message: "disk full" } });
		expect(handler).toHaveBeenCalledWith({ sessionId: "sess-1", message: "disk full" });
	});
});
