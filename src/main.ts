import "@xterm/xterm/css/xterm.css";
import {
  reloadConfig,
  onConfigChanged,
  isLocalConfigWriteRecent,
  type AppError,
} from "./ipc";
import { initDeviceManager } from "./devices/deviceManager";
import { Grid } from "./grid";
import { ProfileManager } from "./profiles/profileManager";
import { SettingsController } from "./settings/settingsController";
import { DEFAULT_TERMINAL_SETTINGS } from "./terminal/terminalSettings";
import { initHostKeyDialog } from "./terminal/hostKeyDialog";
import { initTunnelsPanel } from "./tunnels/tunnelsPanel";
import { initSftpPanel } from "./sftp/sftpPanel";
import { openAboutDialog } from "./ui/aboutDialog";
import { openKnownHostsDialog } from "./settings/knownHostsDialog";
import { showToast } from "./ui/toast";
import { helpIcon, reloadIcon, lockIcon, gearIcon } from "./ui/icons";
import { applyDomTranslations, onLocaleChange, t } from "./i18n";

/** Injects the SVG glyph into each header action button (kept in one place so
 * the icons stay consistent with the app's Bootstrap-Icons set). A missing
 * button is skipped — the markup is static, so this only no-ops in tests. */
function initHeaderIcons(): void {
	const icons: Array<[string, string]> = [
		["#reload-btn", reloadIcon],
		["#trusted-hosts-btn", lockIcon],
		["#settings-btn", gearIcon],
		["#help-btn", helpIcon],
	];
	for (const [selector, svg] of icons) {
		const btn = document.querySelector<HTMLButtonElement>(selector);
		if (btn) btn.innerHTML = svg;
	}
}

window.addEventListener("DOMContentLoaded", () => {
	void initApp();
});

async function initApp(): Promise<void> {
	// Warm the bundled icon font before any terminal renders, so Nerd Font /
	// Powerline glyphs in remote prompts aren't briefly blank on first paint.
	// Best-effort: unsupported/failed loads just fall through (the font also
	// loads lazily the first time a glyph needs it).
	void document.fonts?.load('16px "Symbols Nerd Font Mono"').catch(() => {});

	// Header action buttons: paint their icons, then wire the two that open a
	// dialog directly (help/about and trusted-hosts). Reload and settings are
	// wired further down, next to the state they act on.
	initHeaderIcons();
	document
		.querySelector<HTMLButtonElement>("#help-btn")
		?.addEventListener("click", () => openAboutDialog());
	document
		.querySelector<HTMLButtonElement>("#trusted-hosts-btn")
		?.addEventListener("click", () =>
			openKnownHostsDialog({
				onError: (message) => showToast(t("error.prefix", { message }), "error"),
			}),
		);

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
		onError: (message) => showToast(t("error.prefix", { message }), "error"),
		onChange: () => onWorkspaceChange(),
		getTerminalSettings: () => currentTerminalSettings(),
	});

	// Settings (Phase 5): terminal appearance + UI language. Initialized BEFORE
	// the grid and the other views render, because `settings.init()` resolves and
	// applies the UI locale (stored language → OS → English) and translates the
	// static header; everything built afterwards renders in the right language.
	const settings = new SettingsController({
		grid,
		onError: (message) => showToast(t("error.prefix", { message }), "error"),
	});
	await settings.init();
	currentTerminalSettings = () => settings.terminalSettings();

	await grid.init();

	// Profiles (Phase 4): the sidebar list + toolbar Save/Save As with a
	// dirty-state dot. `init()` loads the start profile — default if set, else
	// the last-used profile, else nothing (1x1) — per SPEC §7.
	const profileManager = new ProfileManager({
		grid,
		onError: (message) => showToast(t("error.prefix", { message }), "error"),
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

	// Tunnels drawer (local port-forwarding): a header-toggled panel listing
	// SSH devices with forwards, with Start/Stop + live status. Independent of
	// the terminal grid (a tunnel has no terminal).
	const tunnelsPanel = initTunnelsPanel({
		onError: (error: AppError) => showToast(t("error.prefix", { message: error.message }), "error"),
		onSuccess: (message: string) => showToast(message, "success"),
	});

	// Files (SFTP) panel: a sidebar card listing SSH devices, each opening a
	// standalone browser drawer for browse + up/download. Independent of the grid.
	const sftpPanel = initSftpPanel({
		onError: (error: AppError) => showToast(t("error.prefix", { message: error.message }), "error"),
		onSuccess: (message: string) => showToast(message, "success"),
	});

	// Device manager: on any successful change, refresh every pane's device
	// dropdown so a newly added/edited/deleted device shows up immediately; also
	// re-sync profiles (a deleted device is nulled out of them backend-side) and
	// the tunnels drawer (a device's forwards may have changed).
	const deviceManager = initDeviceManager({
		onError: (error: AppError) => {
			console.error("Device error:", error);
			showToast(t("error.prefix", { message: error.message }), "error");
		},
		onSuccess: (message: string) => {
			showToast(message, "success");
			void grid.refreshDevices();
			void profileManager.reload();
			void tunnelsPanel.refresh();
			void sftpPanel.refresh();
		},
	});

	// Multi-instance config sync (the multi-window follow-up): each app instance
	// caches the config files in memory at startup, so a change made by another
	// instance (a new device, an edited profile, a font change) is invisible here
	// until reloaded. `reloadAll` re-reads every store on the backend, then
	// re-renders each config-derived surface. Live SSH sessions and the current
	// grid layout are untouched — only the *available* devices / profiles /
	// settings / trusted hosts are refreshed. Wired to a manual header button and
	// to the backend file-watcher's `config_changed` event.
	const reloadAll = async (announce: boolean): Promise<void> => {
		try {
			await reloadConfig();
		} catch (error) {
			showToast(t("error.reloadFailed", { message: (error as AppError).message }), "error");
			return;
		}
		// Independent surfaces: one failing (e.g. a transient IPC error) must not
		// skip the others, so settle all rather than short-circuiting.
		await Promise.allSettled([
			deviceManager?.reload() ?? Promise.resolve(),
			grid.refreshDevices(),
			profileManager.reload(),
			settings.reloadFromDisk(),
			tunnelsPanel.refresh(),
			sftpPanel.refresh(),
		]);
		if (announce) showToast(t("error.reloaded"), "success");
	};

	// Manual Reload button in the header: always reloads, and confirms with a
	// toast so the click has visible feedback even when nothing changed.
	document
		.querySelector<HTMLButtonElement>("#reload-btn")
		?.addEventListener("click", () => void reloadAll(true));

	// Automatic reload when another instance writes a config file. Skip the echo
	// of our *own* just-written change (the watcher can't tell which instance
	// wrote it): `isLocalConfigWriteRecent()` is armed by every local config write.
	void onConfigChanged(() => {
		if (isLocalConfigWriteRecent()) return;
		void reloadAll(true);
	});

	// Live UI language change (from the Settings dialog, or adopted from another
	// instance via `reloadFromDisk`): re-translate the static chrome and re-render
	// every long-lived view in place. Live SSH sessions and the grid layout are
	// untouched — only their labels change.
	onLocaleChange(() => {
		applyDomTranslations(document);
		grid.retranslate();
		profileManager.retranslate();
		deviceManager?.retranslate();
		tunnelsPanel.retranslate();
		sftpPanel.retranslate();
	});
}
