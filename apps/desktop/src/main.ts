import "@xterm/xterm/css/xterm.css";
import {
	reloadConfig,
	onConfigChanged,
	isLocalConfigWriteRecent,
	getWorkspaceState,
	saveWorkspaceState,
	type AppError,
	type WorkspaceState,
} from "./ipc";
import { initDeviceManager } from "./devices/deviceManager";
import { TabManager } from "./tabs/tabManager";
import { ProfileManager, type ProfileWorkspace } from "./profiles/profileManager";
import { SettingsController } from "./settings/settingsController";
import { initHostKeyDialog } from "./terminal/hostKeyDialog";
import { initTunnelsPanel } from "./tunnels/tunnelsPanel";
import { initSftpPanel } from "./sftp/sftpPanel";
import { openAboutDialog } from "./ui/aboutDialog";
import { UpdateController } from "./updates/updateController";
import { applyUpdateBadge } from "./updates/updateBadge";
import { initSidebarResize } from "./layout/sidebarResize";
import { initSidebarRail, type SidebarRail } from "./layout/sidebarRail";
import { initTrayLabels } from "./tray/trayLabels";
import { openKnownHostsDialog } from "./settings/knownHostsDialog";
import { showToast } from "./ui/toast";
import { helpIcon, reloadIcon, lockIcon, gearIcon, filesIcon } from "./ui/icons";
import { applyDomTranslations, onLocaleChange, t } from "./i18n";
import { refreshDevicesAll, reloadConfigAll, retranslateAll, type LiveView } from "./app/liveViews";

/** Injects the SVG glyph into each header action button (kept in one place so
 * the icons stay consistent with the app's Lucide icon set). A missing
 * button is skipped — the markup is static, so this only no-ops in tests. */
function initHeaderIcons(): void {
	const icons: Array<[string, string]> = [
		["#reload-btn", reloadIcon],
		["#trusted-hosts-btn", lockIcon],
		["#sftp-btn", filesIcon],
		["#settings-btn", gearIcon],
		["#help-btn", helpIcon],
	];
	for (const [selector, svg] of icons) {
		const btn = document.querySelector<HTMLButtonElement>(selector);
		if (btn) btn.innerHTML = svg;
	}
}

const showError = (message: string): void => showToast(t("error.prefix", { message }), "error");
const showAppError = (error: AppError): void => showError(error.message);
const showSuccess = (message: string): void => showToast(message, "success");

function wireClick(selector: string, handler: () => void): void {
	document.querySelector<HTMLButtonElement>(selector)?.addEventListener("click", handler);
}

window.addEventListener("DOMContentLoaded", () => {
	void initApp();
});

async function initApp(): Promise<void> {
	initChrome();
	const paneRoot = document.querySelector<HTMLElement>("#pane-root");
	if (!paneRoot) return;

	// First: it applies the UI language, so every view built afterwards renders in it.
	const settings = new SettingsController({ onError: showError });
	await settings.init();
	const tabs = createTabs(paneRoot, settings);
	const updates = initUpdates(tabs);
	const workspace = await loadWorkspace();
	const rail = initSidebar(paneRoot, tabs, workspace);
	await tabs.init(workspace.tabs.length > 0 ? workspace : undefined);
	const views = await initViews({ tabs, settings, updates, rail, workspace });
	wireConfigReload(views);
	wireLocaleChange(views);
	void initTrayLabels();
	checkUpdatesOnLaunch(updates, settings);
}

/** What needs nothing else: header icons and the dialogs any part may raise. */
function initChrome(): void {
	// Warm the bundled icon font before any terminal renders, so Nerd Font /
	// Powerline glyphs in remote prompts aren't briefly blank on first paint.
	void document.fonts?.load('16px "Symbols Nerd Font Mono"').catch(() => {});
	initHeaderIcons();
	wireClick("#trusted-hosts-btn", () => openKnownHostsDialog({ onError: showError }));
	// Reacts to `host_key_prompt` from any source (a live connect or Test connection).
	initHostKeyDialog();
}

/** Each tab owns an independent grid of terminals; hidden tabs keep their
 * sessions running. Profile/settings actions target the active tab's grid. */
function createTabs(paneRoot: HTMLElement, settings: SettingsController): TabManager {
	const tabs = new TabManager(paneRoot, {
		grid: { onError: showError, getTerminalSettings: () => settings.terminalSettings() },
		// Per-instance UI state — plain save, not routed through the config watcher.
		persist: (state) => void saveWorkspaceState(state).catch(showAppError),
		// The app-action buttons move into the tab-strip row (no separate header).
		headerActions: document.querySelector<HTMLElement>(".header-actions"),
	});
	settings.onTerminalSettingsChange((s) => tabs.forEachGrid((g) => g.applyTerminalSettings(s)));
	return tabs;
}

/** About hosts the manual check; a found release badges its button. */
function initUpdates(tabs: TabManager): UpdateController {
	// Installing restarts the app: save the tab layout now rather than trusting
	// the debounced save to land first.
	const updates = new UpdateController({ beforeInstall: () => saveWorkspaceState(tabs.serialize()) });
	updates.onInstallError((message) => showToast(t("updates.failed", { message }), "error"));
	const helpBtn = document.querySelector<HTMLButtonElement>("#help-btn");
	updates.subscribe(() => {
		if (helpBtn) applyUpdateBadge(helpBtn, updates.available() !== null);
	});
	wireClick("#help-btn", () => openAboutDialog(updates));
	return updates;
}

/** The saved tab set; empty → one blank tab, into which ProfileManager loads
 * the start profile. */
async function loadWorkspace(): Promise<WorkspaceState> {
	try {
		return await getWorkspaceState();
	} catch (error) {
		showAppError(error as AppError);
		return { tabs: [], activeIndex: 0 };
	}
}

/**
 * The resizable, collapsible left menu. Applied before the tabs restore (which
 * can take seconds while hosts connect) so the menu doesn't snap shut
 * afterwards. Collapsed, it is a thin bar with the connected-device and
 * running-forward counts.
 */
function initSidebar(paneRoot: HTMLElement, tabs: TabManager, workspace: WorkspaceState): SidebarRail | null {
	const sidebarEl = document.querySelector<HTMLElement>(".sidebar");
	const handle = document.querySelector<HTMLElement>(".sidebar-splitter");
	if (!sidebarEl || !handle) return null;
	const sidebar = initSidebarResize({
		sidebar: sidebarEl,
		handle,
		paneRoot,
		initialWidth: workspace.sidebarWidth,
		onLayoutChange: () => tabs.refitActive(),
		onPersist: () => tabs.scheduleSave(),
	});
	tabs.addStateContributor(() => ({ sidebarWidth: sidebar.persistedWidth() }));
	return initRail(sidebarEl, handle, tabs, workspace, () => sidebar.reclamp());
}

function initRail(
	sidebar: HTMLElement,
	splitter: HTMLElement,
	tabs: TabManager,
	workspace: WorkspaceState,
	reclampSidebar: () => void,
): SidebarRail {
	const rail = initSidebarRail({
		sidebar,
		splitter,
		initialCollapsed: workspace.sidebarCollapsed,
		countDevices: () => tabs.connectedDeviceCount(),
		// An expanded menu may come back wider than the window now allows.
		onLayoutChange: () => {
			reclampSidebar();
			tabs.refitActive();
		},
		onPersist: () => tabs.scheduleSave(),
	});
	tabs.addStateContributor(() => ({ sidebarCollapsed: rail.persistedCollapsed() }));
	tabs.onConnectionChange(() => rail.refresh());
	return rail;
}

interface AppParts {
	tabs: TabManager;
	settings: SettingsController;
	updates: UpdateController;
	rail: SidebarRail | null;
	workspace: WorkspaceState;
}

/** Builds the views around the tabs; each one a device change, a config
 * reload or a language change has to reach. */
async function initViews(parts: AppParts): Promise<LiveView[]> {
	const { tabs, settings } = parts;
	const views: LiveView[] = [
		{
			refreshDevices: () => Promise.allSettled(tabs.mapGrids((g) => g.refreshDevices())),
			retranslate: () => {
				tabs.forEachGrid((g) => g.retranslate());
				tabs.retranslate();
			},
		},
		{ reloadConfig: () => settings.reloadFromDisk() },
	];
	views.push(await initProfiles(parts));
	views.push(initTunnels(parts));
	views.push(initSftp(parts));
	const devices = initDevices(parts, views);
	if (devices) views.push(devices);
	return views;
}

/** The sidebar profile list + Save/Save As, acting on the active tab's grid. */
async function initProfiles({ tabs, settings, workspace }: AppParts): Promise<LiveView> {
	const profileManager = new ProfileManager({
		workspace: makeProfileWorkspace(tabs),
		onError: showError,
		onSuccess: showSuccess,
		// Remember the active tab's profile so a restart without a default reloads it.
		onProfileChange: (id) => void settings.persistLastProfileId(id),
	});
	tabs.onWorkspaceChange(() => profileManager.refreshDirty());
	tabs.onActiveTabChange(() => profileManager.onActiveTabChanged());
	tabs.setTabStateResolver((id) => profileManager.resolveTabState(id));
	await profileManager.init(settings.lastProfileId(), { loadStart: workspace.tabs.length === 0 });
	return { refreshDevices: () => profileManager.reload(), retranslate: () => profileManager.retranslate() };
}

function makeProfileWorkspace(tabs: TabManager): ProfileWorkspace {
	return {
		activeLinkedProfileId: () => tabs.activeLinkedProfileId(),
		activeGroupGrids: () => tabs.activeGroupGrids(),
		groupGrids: (id) => tabs.groupGrids(id),
		linkedProfileIds: () => tabs.linkedProfileIds(),
		activateGrid: (grid) => tabs.activateGrid(grid),
		tabSnapshots: (grids) => tabs.tabSnapshots(grids),
		linkProfile: (grid, id) => tabs.setLinkedProfileId(grid, id),
		refreshTabStrip: () => tabs.refreshStrip(),
		clearProfileLink: (id) => tabs.clearProfileLink(id),
		openTabs: (names, id, replacing) => tabs.openTabs(names, id, replacing),
	};
}

/** Port forwards: Start/Stop per device with live status. */
function initTunnels({ tabs, rail, workspace }: AppParts): LiveView {
	const tunnelsPanel = initTunnelsPanel({
		onError: showAppError,
		onSuccess: showSuccess,
		initialState: workspace.tunnels,
		onPersist: () => tabs.scheduleSave(),
		onForwardsChange: () => rail?.refresh(),
	});
	tabs.addStateContributor(() => ({ tunnels: tunnelsPanel.layoutState() }));
	rail?.countForwardsWith(() => tunnelsPanel.listeningForwardCount());
	return { refreshDevices: () => tunnelsPanel.refresh(), retranslate: () => tunnelsPanel.retranslate() };
}

/** The Files panel docked right of the grid; opening/resizing it re-fits the grid. */
function initSftp({ tabs, settings, updates, workspace }: AppParts): LiveView {
	const sftpPanel = initSftpPanel({
		onError: showAppError,
		onSuccess: showSuccess,
		getIdleDisconnectMins: () => settings.sftpSettings().idleDisconnectMins,
		onLayoutChange: () => tabs.activeGrid().refit(),
		onPersist: () => tabs.scheduleSave(),
		initialState: workspace.sftp,
	});
	settings.onSftpSettingsChange(() => sftpPanel.onIdleSettingChange());
	// On Windows sessions close before the install; if it then failed, the panel
	// must stop showing a connection that is gone.
	updates.onInstallError(() => void sftpPanel.resyncConnection());
	tabs.addStateContributor(() => ({ sftp: sftpPanel.layoutState() }));
	wireClick("#sftp-btn", () => sftpPanel.toggle());
	return { refreshDevices: () => sftpPanel.refresh(), retranslate: () => sftpPanel.retranslate() };
}

/** The device list and editor: a change reaches every view showing devices
 * (a deleted device is also nulled out of profiles backend-side). */
function initDevices({ tabs, workspace }: AppParts, views: readonly LiveView[]): LiveView | null {
	const deviceManager = initDeviceManager({
		onError: (error: AppError) => {
			console.error("Device error:", error);
			showAppError(error);
		},
		onSuccess: (message: string) => {
			showSuccess(message);
			void refreshDevicesAll(views);
		},
		initialCollapsedGroups: workspace.collapsedDeviceGroups,
		onPersist: () => tabs.scheduleSave(),
	});
	if (!deviceManager) return null;
	tabs.addStateContributor(() => ({ collapsedDeviceGroups: deviceManager.collapsedGroups() }));
	return { reloadConfig: () => deviceManager.reload(), retranslate: () => deviceManager.retranslate() };
}

/**
 * Multi-instance config sync: each instance caches the config files at
 * startup, so another instance's change is invisible here until reloaded.
 * Live sessions and the grid layout are untouched. Wired to the header button
 * and to the backend watcher's `config_changed` event.
 */
function wireConfigReload(views: readonly LiveView[]): void {
	const reloadAll = async (): Promise<void> => {
		try {
			await reloadConfig();
		} catch (error) {
			showToast(t("error.reloadFailed", { message: (error as AppError).message }), "error");
			return;
		}
		await reloadConfigAll(views);
		showToast(t("error.reloaded"), "success");
	};
	wireClick("#reload-btn", () => void reloadAll());
	// Skip the echo of our own write: the watcher can't tell which instance wrote it.
	void onConfigChanged(() => {
		if (!isLocalConfigWriteRecent()) void reloadAll();
	});
}

/** Re-translates the static chrome and every view in place (live sessions
 * and the grid layout are untouched). */
function wireLocaleChange(views: readonly LiveView[]): void {
	onLocaleChange(() => {
		applyDomTranslations(document);
		retranslateAll(views);
	});
}

/** Opt-in, last so it never delays startup: the app contacts no server unless asked. */
function checkUpdatesOnLaunch(updates: UpdateController, settings: SettingsController): void {
	void updates.maybeCheckOnLaunch(settings.checkUpdatesOnLaunch()).then((info) => {
		if (info) showToast(t("updates.toast", { version: info.version }), "success");
	});
}
