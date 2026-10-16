/**
 * @vitest-environment happy-dom
 *
 * Wire-shape tests for the import/export wrappers. Each wrapper must forward the backend command name with the exact camelCase payload the matching Rust `#[tauri::command]` expects. `@tauri-apps/api`'s `invoke` and `listen` are mocked.
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
	exportDevices,
	importDevices,
	previewDevicesImport,
	saveTextFile,
	exportProfiles,
	importProfiles,
} from "./transfer";

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

	it("importDevices sends the risks the user confirmed", async () => {
		invokeMock.mockResolvedValue(3);
		const confirmedRisks = [{ name: "Box", risks: ["agentForwarding" as const] }];
		expect(await importDevices("C:/tmp/file.json", confirmedRisks)).toBe(3);
		expect(invokeMock).toHaveBeenCalledWith("import_devices", {
			path: "C:/tmp/file.json",
			confirmedRisks,
		});
	});

	it("previewDevicesImport calls preview_devices_import with { path }", async () => {
		invokeMock.mockResolvedValue([]);
		expect(await previewDevicesImport("C:/tmp/file.json")).toEqual([]);
		expect(invokeMock).toHaveBeenCalledWith("preview_devices_import", {
			path: "C:/tmp/file.json",
		});
	});

	it("normalizes a rejected AppError from the backend", async () => {
		invokeMock.mockRejectedValue({ code: "Validation", message: "bad kind" });
		await expect(importDevices("C:/tmp/bad.json", [])).rejects.toEqual({
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
