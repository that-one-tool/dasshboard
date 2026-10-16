/**
 * @vitest-environment happy-dom
 *
 * Wire-shape tests for the SFTP edit-in-place wrappers. Each wrapper must forward the backend command name with the exact camelCase payload the matching Rust `#[tauri::command]` expects. `@tauri-apps/api`'s `invoke` and `listen` are mocked.
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
	sftpEditOpen,
	sftpEditLaunch,
	sftpEditCheck,
	sftpEditUpload,
	sftpEditDiscard,
	sftpEditClose,
	sftpEditableSize,
	onSftpEditChanged,
} from "./sftpEdit";

beforeEach(() => {
	invokeMock.mockReset();
	listenMock.mockReset();
});

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
