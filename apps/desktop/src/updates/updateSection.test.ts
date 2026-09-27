/**
 * @vitest-environment happy-dom
 *
 * The update block inside the About dialog: a Check button, a status line, the
 * release notes, and either Install & restart (self-installing builds) or a
 * Download link (.deb/.rpm). Renders from the controller's state (so it is
 * right even when reopened mid-install) and re-renders on its changes. Uses a
 * minimal fake `UpdateController`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UpdateInfo } from "../ipc";
import type { UpdateController } from "./updateController";
import { DOWNLOAD_PAGE_URL, mountUpdateSection } from "./updateSection";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

class FakeUpdates {
	found: UpdateInfo | null = null;
	installing = false;
	listeners = new Set<() => void>();
	check = vi.fn(async (): Promise<UpdateInfo | null> => this.found);
	install = vi.fn(async (): Promise<boolean> => false);
	available(): UpdateInfo | null {
		return this.found;
	}
	isInstalling(): boolean {
		return this.installing;
	}
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	emit(): void {
		this.listeners.forEach((l) => l());
	}
}

function mount(fake: FakeUpdates): () => void {
	return mountUpdateSection(q("#slot"), fake as unknown as UpdateController);
}

function q<T extends HTMLElement>(selector: string): T {
	const el = document.querySelector<T>(selector);
	if (!el) throw new Error(`missing ${selector}`);
	return el;
}

const installable: UpdateInfo = { version: "1.21.0", notes: "Fixes", canInstall: true };
const notifyOnly: UpdateInfo = { ...installable, notes: null, canInstall: false };

beforeEach(() => {
	document.body.innerHTML = '<div id="slot"></div>';
});

describe("mountUpdateSection", () => {
	it("starts idle with only the Check button when no update is known", () => {
		mount(new FakeUpdates());
		expect(q('[data-update="check"]').hidden).toBe(false);
		expect(q('[data-update="install"]').hidden).toBe(true);
		expect(q('[data-update="download"]').hidden).toBe(true);
		expect(q(".about-update-status").textContent).toBe("");
	});

	it("shows a release already found by the launch check", () => {
		const fake = new FakeUpdates();
		fake.found = installable;
		mount(fake);
		expect(q(".about-update-status").textContent).toContain("1.21.0");
		expect(q(".about-update-notes").textContent).toBe("Fixes");
		expect(q('[data-update="install"]').hidden).toBe(false);
	});

	it("reports up to date after a check that finds nothing", async () => {
		mount(new FakeUpdates());
		q<HTMLButtonElement>('[data-update="check"]').click();
		expect(q(".about-update-status").textContent).toBe("Checking for updates…");
		await flush();
		expect(q(".about-update-status").textContent).toBe("You're up to date.");
		expect(q<HTMLButtonElement>('[data-update="check"]').disabled).toBe(false);
	});

	it("hides a stale Install button when a re-check finds nothing", async () => {
		const fake = new FakeUpdates();
		fake.found = installable;
		mount(fake);
		fake.check.mockImplementation(async () => {
			fake.found = null;
			fake.emit();
			return null;
		});

		q<HTMLButtonElement>('[data-update="check"]').click();
		await flush();

		expect(q('[data-update="install"]').hidden).toBe(true);
		expect(q(".about-update-notes").hidden).toBe(true);
		expect(q(".about-update-status").textContent).toBe("You're up to date.");
	});

	it("offers a download link instead of install for a notify-only build", () => {
		const fake = new FakeUpdates();
		fake.found = notifyOnly;
		mount(fake);
		expect(q('[data-update="install"]').hidden).toBe(true);
		const link = q<HTMLAnchorElement>('[data-update="download"]');
		expect(link.hidden).toBe(false);
		expect(link.getAttribute("href")).toBe(DOWNLOAD_PAGE_URL);
		expect(link.getAttribute("target")).toBe("_blank");
		expect(q(".about-update-notes").hidden).toBe(true);
	});

	it("shows the error when a check fails", async () => {
		const fake = new FakeUpdates();
		fake.check.mockRejectedValue({ code: "Update", message: "offline" });
		mount(fake);
		q<HTMLButtonElement>('[data-update="check"]').click();
		await flush();
		expect(q(".about-update-status").textContent).toBe("Couldn't check for updates: offline");
	});

	it("keeps a failed re-check's error visible when a release is already known", async () => {
		const fake = new FakeUpdates();
		fake.found = installable;
		fake.check.mockRejectedValue({ code: "Update", message: "offline" });
		mount(fake);

		q<HTMLButtonElement>('[data-update="check"]').click();
		await flush();

		expect(q(".about-update-status").textContent).toBe("Couldn't check for updates: offline");
		expect(q('[data-update="install"]').hidden).toBe(false);
	});

	it("renders the installing state, including when reopened mid-install", () => {
		const fake = new FakeUpdates();
		fake.found = installable;
		fake.installing = true;
		mount(fake);
		expect(q(".about-update-status").textContent).toBe("Downloading and installing…");
		expect(q<HTMLButtonElement>('[data-update="install"]').disabled).toBe(true);
		expect(q<HTMLButtonElement>('[data-update="check"]').disabled).toBe(true);
	});

	it("re-enables Install when the user cancels the confirm", async () => {
		const fake = new FakeUpdates();
		fake.found = installable;
		mount(fake);
		const button = q<HTMLButtonElement>('[data-update="install"]');
		button.click();
		expect(button.disabled).toBe(true);
		await flush();
		expect(fake.install).toHaveBeenCalledTimes(1);
		expect(button.disabled).toBe(false);
	});

	it("follows the controller's changes until unmounted", () => {
		const fake = new FakeUpdates();
		const unmount = mount(fake);
		fake.found = installable;
		fake.emit();
		expect(q('[data-update="install"]').hidden).toBe(false);

		unmount();
		expect(fake.listeners.size).toBe(0);
	});
});
