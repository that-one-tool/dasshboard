import "@xterm/xterm/css/xterm.css";
import { ping, type AppError } from "./ipc";
import { formatPingMessage } from "./version";
import { initDeviceManager } from "./devices/deviceManager";
import { Grid } from "./grid";
import { ProfileManager } from "./profiles/profileManager";
import { SettingsController } from "./settings/settingsController";
import { DEFAULT_TERMINAL_SETTINGS } from "./terminal/terminalSettings";
import { initHostKeyDialog } from "./terminal/hostKeyDialog";

/** Calls the `ping` command and renders the result (proves IPC round trip). */
function initVersionBanner(): void {
	const el = document.querySelector<HTMLElement>("#version-banner");
	if (!el) return;

	ping()
		.then((version) => {
			el.textContent = formatPingMessage(version);
		})
		.catch((error: unknown) => {
			el.textContent = `Ping failed (${String(error)})`;
		});
}

/**
 * Shows a toast notification for errors or success messages.
 */
function showToast(message: string, type: "error" | "success" = "error"): void {
	// Find or create toast container
	let container = document.querySelector(".toast-container");
	if (!container) {
		container = document.createElement("div");
		container.className = "toast-container";
		document.body.appendChild(container);
	}

	const toast = document.createElement("div");
	toast.className = `toast toast-${type}`;
	toast.textContent = message;
	toast.setAttribute("role", "status");
	toast.setAttribute("aria-live", "polite");

	container.appendChild(toast);

	// Auto-remove after 4 seconds
	setTimeout(() => {
		toast.remove();
	}, 4000);
}

window.addEventListener("DOMContentLoaded", () => {
	void initApp();
});

async function initApp(): Promise<void> {
	initVersionBanner();

	// Host-key trust dialog reacts to `host_key_prompt` events from any source
	// (a live connect or the device editor's Test connection button).
	initHostKeyDialog();

	// The multi-pane grid of SSH terminals (Phase 3). Starts as a 1x1 grid; the
	// toolbar preset picker grows/shrinks it and each cell is an independent
	// `TerminalPane` managing its own session/status/overlay.
	const paneRoot = document.querySelector<HTMLElement>("#pane-root");
	if (!paneRoot) return;

	// `onChange` is wired to the collaborators once they exist (below); the grid
	// is constructed first, so route through a late-bound callback. Terminal
	// settings are read live via `settings` (also constructed after the grid).
	let onWorkspaceChange = (): void => {};
	let currentTerminalSettings = () => DEFAULT_TERMINAL_SETTINGS;
	const grid = new Grid(paneRoot, {
		onError: (message) => showToast(`Error: ${message}`, "error"),
		onChange: () => onWorkspaceChange(),
		getTerminalSettings: () => currentTerminalSettings(),
	});
	await grid.init();

	// Settings (Phase 5): terminal appearance applied live + last-used grid.
	const settings = new SettingsController({
		grid,
		onError: (message) => showToast(`Error: ${message}`, "error"),
	});
	await settings.init();
	currentTerminalSettings = () => settings.terminalSettings();

	// Profiles (Phase 4): the sidebar list + toolbar Save/Save As with a
	// dirty-state dot. `init()` loads the start profile — default if set, else
	// the last-used profile, else nothing (1x1) — per SPEC §7.
	const profileManager = new ProfileManager({
		grid,
		onError: (message) => showToast(`Error: ${message}`, "error"),
		onSuccess: (message) => showToast(message, "success"),
		// Remember the loaded profile so a restart without a default reloads it.
		onProfileChange: (id) => void settings.persistLastProfileId(id),
	});
	// A workspace change just updates the dirty dot; the last-used *profile* is
	// tracked via `onProfileChange`, not the live (possibly unsaved) grid.
	onWorkspaceChange = () => {
		profileManager.refreshDirty();
	};
	await profileManager.init(settings.lastProfileId());

	// Device manager: on any successful change, refresh every pane's device
	// dropdown so a newly added/edited/deleted device shows up immediately; also
	// re-sync profiles (a deleted device is nulled out of them backend-side).
	initDeviceManager({
		onError: (error: AppError) => {
			console.error("Device error:", error);
			showToast(`Error: ${error.message}`, "error");
		},
		onSuccess: (message: string) => {
			showToast(message, "success");
			void grid.refreshDevices();
			void profileManager.reload();
		},
	});
}
