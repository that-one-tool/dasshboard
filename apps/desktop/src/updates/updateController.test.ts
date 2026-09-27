/**
 * `UpdateController`: remembers the release found by the last check and
 * notifies subscribers, gates the launch check on the user's opt-in (the
 * privacy promise), and installs only after a confirm — download, then the
 * `beforeInstall` flush, then install, each naming the confirmed version. A
 * failed install is reported and retryable. `../ipc` and the confirm dialog
 * are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UpdateInfo } from "../ipc";

vi.mock("../ipc", () => ({
	checkUpdate: vi.fn(),
	downloadUpdate: vi.fn(),
	installUpdate: vi.fn(),
}));
vi.mock("../ui/confirm", () => ({ confirm: vi.fn() }));

import { UpdateController, type UpdateControllerOptions } from "./updateController";
import { checkUpdate, downloadUpdate, installUpdate } from "../ipc";
import { confirm } from "../ui/confirm";

const found: UpdateInfo = { version: "1.21.0", notes: "Fixes", canInstall: true };

function controller(overrides: Partial<UpdateControllerOptions> = {}): UpdateController {
	return new UpdateController({
		beforeInstall: vi.fn(async () => {}),
		onInstallError: vi.fn(),
		...overrides,
	});
}

async function withFound(overrides: Partial<UpdateControllerOptions> = {}): Promise<UpdateController> {
	vi.mocked(checkUpdate).mockResolvedValue(found);
	const updates = controller(overrides);
	await updates.check();
	return updates;
}

beforeEach(() => {
	vi.mocked(checkUpdate).mockReset();
	vi.mocked(downloadUpdate).mockReset().mockResolvedValue(undefined);
	vi.mocked(installUpdate).mockReset().mockResolvedValue(undefined);
	vi.mocked(confirm).mockReset().mockResolvedValue(true);
});

describe("UpdateController.check", () => {
	it("remembers a found release and notifies subscribers", async () => {
		vi.mocked(checkUpdate).mockResolvedValue(found);
		const updates = controller();
		const listener = vi.fn();
		updates.subscribe(listener);

		await expect(updates.check()).resolves.toEqual(found);

		expect(updates.available()).toEqual(found);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("clears a previously found release when a re-check finds nothing", async () => {
		const updates = await withFound();
		vi.mocked(checkUpdate).mockResolvedValue(null);

		await expect(updates.check()).resolves.toBeNull();

		expect(updates.available()).toBeNull();
	});

	it("propagates a failed check and keeps the known release", async () => {
		const updates = await withFound();
		vi.mocked(checkUpdate).mockRejectedValue({ code: "Update", message: "offline" });

		await expect(updates.check()).rejects.toEqual({ code: "Update", message: "offline" });

		expect(updates.available()).toEqual(found);
	});

	it("stops notifying after unsubscribe", async () => {
		vi.mocked(checkUpdate).mockResolvedValue(found);
		const updates = controller();
		const listener = vi.fn();
		const unsubscribe = updates.subscribe(listener);
		unsubscribe();

		await updates.check();

		expect(listener).not.toHaveBeenCalled();
	});
});

describe("UpdateController.maybeCheckOnLaunch", () => {
	it("never contacts the update server when the user did not opt in", async () => {
		const updates = controller();
		await expect(updates.maybeCheckOnLaunch(false)).resolves.toBeNull();
		expect(checkUpdate).not.toHaveBeenCalled();
	});

	it("checks when opted in and returns the found release", async () => {
		vi.mocked(checkUpdate).mockResolvedValue(found);
		const updates = controller();
		await expect(updates.maybeCheckOnLaunch(true)).resolves.toEqual(found);
	});

	it("swallows a failure (a background check must not raise an error)", async () => {
		vi.mocked(checkUpdate).mockRejectedValue({ code: "Update", message: "offline" });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const updates = controller();

		await expect(updates.maybeCheckOnLaunch(true)).resolves.toBeNull();

		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe("UpdateController.install", () => {
	it("downloads, flushes, then installs the confirmed version, in that order", async () => {
		const order: string[] = [];
		vi.mocked(downloadUpdate).mockImplementation(async () => void order.push("download"));
		vi.mocked(installUpdate).mockImplementation(async () => void order.push("install"));
		const beforeInstall = vi.fn(async () => void order.push("flush"));
		const updates = await withFound({ beforeInstall });

		await expect(updates.install()).resolves.toBe(true);

		expect(vi.mocked(confirm).mock.calls[0]?.[0]).toContain("1.21.0");
		expect(order).toEqual(["download", "flush", "install"]);
		expect(downloadUpdate).toHaveBeenCalledWith("1.21.0");
		expect(installUpdate).toHaveBeenCalledWith("1.21.0");
	});

	it("is marked installing while it runs, and notifies subscribers", async () => {
		let release!: () => void;
		vi.mocked(downloadUpdate).mockImplementation(() => new Promise((r) => (release = () => r())));
		const updates = await withFound();
		const states: boolean[] = [];
		updates.subscribe(() => states.push(updates.isInstalling()));

		const running = updates.install();
		await vi.waitFor(() => expect(updates.isInstalling()).toBe(true));
		release();
		await running;

		expect(states).toEqual([true, false]);
	});

	it("does nothing when the user cancels", async () => {
		vi.mocked(confirm).mockResolvedValue(false);
		const updates = await withFound();

		await expect(updates.install()).resolves.toBe(false);

		expect(downloadUpdate).not.toHaveBeenCalled();
	});

	it("does nothing when no release is known", async () => {
		const updates = controller();
		await expect(updates.install()).resolves.toBe(false);
		expect(confirm).not.toHaveBeenCalled();
	});

	it("ignores a second install while one is running", async () => {
		vi.mocked(downloadUpdate).mockImplementation(() => new Promise(() => {}));
		const updates = await withFound();
		void updates.install();
		await vi.waitFor(() => expect(updates.isInstalling()).toBe(true));

		await expect(updates.install()).resolves.toBe(false);

		expect(confirm).toHaveBeenCalledTimes(1);
	});

	it("reports a failure, clears installing, and allows a retry", async () => {
		vi.mocked(downloadUpdate).mockRejectedValueOnce({ code: "Update", message: "network down" });
		const onInstallError = vi.fn();
		const updates = await withFound({ onInstallError });

		await expect(updates.install()).resolves.toBe(false);

		expect(onInstallError).toHaveBeenCalledWith("network down");
		expect(updates.isInstalling()).toBe(false);
		expect(installUpdate).not.toHaveBeenCalled();
		await expect(updates.install()).resolves.toBe(true);
	});

	it("does not re-check while installing", async () => {
		vi.mocked(downloadUpdate).mockImplementation(() => new Promise(() => {}));
		const updates = await withFound();
		void updates.install();
		await vi.waitFor(() => expect(updates.isInstalling()).toBe(true));

		await expect(updates.check()).resolves.toEqual(found);

		expect(checkUpdate).toHaveBeenCalledTimes(1);
	});
});
