import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../i18n";
import { initTrayLabels, trayLabels, type TrayLabelDeps } from "./trayLabels";

afterEach(() => setLocale("en"));

describe("trayLabels", () => {
	it("pluralizes the live-connection count and translates the actions", () => {
		expect(trayLabels(1)).toEqual({
			connections: "1 live connection",
			show: "Show DaSSHboard",
			quit: "Quit",
		});
		expect(trayLabels(3).connections).toBe("3 live connections");
	});

	it("follows the current locale", () => {
		setLocale("fr");
		expect(trayLabels(0).connections).toBe("0 connexion active");
		expect(trayLabels(0).quit).toBe("Quitter");
	});

	it("uses the plural for zero in Portuguese", () => {
		setLocale("pt");
		expect(trayLabels(0).connections).toBe("0 ligações ativas");
		expect(trayLabels(1).connections).toBe("1 ligação ativa");
	});
});

function fakeDeps(currentCount = 0) {
	let countHandler: ((count: number) => void) | undefined;
	let localeHandler: (() => void) | undefined;
	const deps: TrayLabelDeps = {
		setTrayLabels: vi.fn().mockResolvedValue(undefined),
		getLiveSessionCount: vi.fn().mockResolvedValue(currentCount),
		onLiveSessionCount: vi.fn(async (handler) => {
			countHandler = handler;
			return () => {};
		}),
		onLocaleChange: vi.fn((listener) => {
			localeHandler = listener;
			return () => {};
		}),
	};
	return {
		deps,
		emitCount: (count: number) => countHandler?.(count),
		changeLocale: () => localeHandler?.(),
	};
}

describe("initTrayLabels", () => {
	it("pushes the current count once subscribed (a change before then isn't lost)", async () => {
		const { deps } = fakeDeps(3);
		await initTrayLabels(deps);
		expect(deps.onLiveSessionCount).toHaveBeenCalled();
		expect(deps.setTrayLabels).toHaveBeenLastCalledWith(trayLabels(3));
	});

	it("keeps an event that arrives while the current count is being fetched", async () => {
		const { deps, emitCount } = fakeDeps(1);
		vi.mocked(deps.getLiveSessionCount).mockImplementation(async () => {
			emitCount(5); // newer than the fetched value
			return 1;
		});
		await initTrayLabels(deps);
		expect(deps.setTrayLabels).toHaveBeenLastCalledWith(trayLabels(5));
	});

	it("re-pushes when the live-session count changes", async () => {
		const { deps, emitCount } = fakeDeps();
		await initTrayLabels(deps);
		emitCount(2);
		expect(deps.setTrayLabels).toHaveBeenLastCalledWith(trayLabels(2));
	});

	it("re-pushes the last count in the new language on a locale change", async () => {
		const { deps, emitCount, changeLocale } = fakeDeps();
		await initTrayLabels(deps);
		emitCount(4);
		setLocale("fr");
		changeLocale();
		expect(deps.setTrayLabels).toHaveBeenLastCalledWith(
			expect.objectContaining({ connections: "4 connexions actives", quit: "Quitter" }),
		);
	});

	it("swallows a failed push (the tray is best-effort)", async () => {
		const { deps } = fakeDeps();
		vi.mocked(deps.setTrayLabels).mockRejectedValue(new Error("no tray"));
		vi.mocked(deps.getLiveSessionCount).mockRejectedValue(new Error("ipc"));
		await expect(initTrayLabels(deps)).resolves.toBeUndefined();
	});
});
