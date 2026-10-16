/**
 * @vitest-environment happy-dom
 *
 * Wire-shape tests for the tunnel wrappers. `@tauri-apps/api`'s `invoke` and `listen` are mocked.
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

import { listTunnels, onTunnelStatus, startTunnel, startTunnelForward, stopTunnel, stopTunnelForward } from "./tunnels";

beforeEach(() => {
	invokeMock.mockReset();
	listenMock.mockReset();
});

describe("tunnel wrapper argument shapes", () => {
	it("startTunnel sends { tunnelId, deviceId, forwardIds } and returns the id", async () => {
		invokeMock.mockResolvedValue("t1");
		await expect(startTunnel("d1", "t1", ["f1"])).resolves.toBe("t1");
		expect(invokeMock).toHaveBeenCalledWith("start_tunnel", { tunnelId: "t1", deviceId: "d1", forwardIds: ["f1"] });
	});

	it("stopTunnel sends { tunnelId }", async () => {
		invokeMock.mockResolvedValue(undefined);
		await stopTunnel("t1");
		expect(invokeMock).toHaveBeenCalledWith("stop_tunnel", { tunnelId: "t1" });
	});

	it("start/stopTunnelForward send { tunnelId, forwardId }", async () => {
		invokeMock.mockResolvedValue(undefined);
		await startTunnelForward("t1", "f1");
		await stopTunnelForward("t1", "f1");
		expect(invokeMock.mock.calls).toEqual([
			["start_tunnel_forward", { tunnelId: "t1", forwardId: "f1" }],
			["stop_tunnel_forward", { tunnelId: "t1", forwardId: "f1" }],
		]);
	});

	it("listTunnels forwards no arguments", async () => {
		invokeMock.mockResolvedValue([]);
		await expect(listTunnels()).resolves.toEqual([]);
		expect(invokeMock).toHaveBeenCalledWith("list_tunnels");
	});

	it("onTunnelStatus subscribes to tunnel_status and unwraps the payload", async () => {
		let captured: ((e: { payload: unknown }) => void) | undefined;
		listenMock.mockImplementation((_event: string, cb: (e: { payload: unknown }) => void) => {
			captured = cb;
			return Promise.resolve(vi.fn());
		});
		const handler = vi.fn();
		await onTunnelStatus(handler);
		expect(listenMock).toHaveBeenCalledWith("tunnel_status", expect.any(Function));
		const payload = { tunnelId: "t1", status: "listening", forwards: [] };
		captured?.({ payload });
		expect(handler).toHaveBeenCalledWith(payload);
	});
});
