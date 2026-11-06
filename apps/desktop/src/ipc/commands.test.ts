/**
 * @vitest-environment happy-dom
 *
 * Wire-shape tests for the command library wrappers: each forwards the backend
 * command name with the camelCase payload its Rust `#[tauri::command]` expects.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { listCommands, saveCommand, deleteCommand, type SavedCommand } from "./commands";
import { isLocalConfigWriteRecent } from "./invoke";

const command: SavedCommand = { id: "", name: "Uptime", text: "uptime", run: true };

beforeEach(() => {
	invokeMock.mockReset();
});

describe("command library IPC wrappers", () => {
	it("listCommands invokes list_commands", async () => {
		invokeMock.mockResolvedValueOnce([command]);
		await expect(listCommands()).resolves.toEqual([command]);
		expect(invokeMock).toHaveBeenCalledWith("list_commands");
	});

	it("saveCommand sends { command } and marks a config write", async () => {
		invokeMock.mockResolvedValueOnce({ ...command, id: "c1" });
		await expect(saveCommand(command)).resolves.toEqual({ ...command, id: "c1" });
		expect(invokeMock).toHaveBeenCalledWith("save_command", { command });
		expect(isLocalConfigWriteRecent()).toBe(true);
	});

	it("deleteCommand sends { id }", async () => {
		invokeMock.mockResolvedValueOnce(undefined);
		await deleteCommand("c1");
		expect(invokeMock).toHaveBeenCalledWith("delete_command", { id: "c1" });
	});
});
