/**
 * App-update state: remembers the release found by the last check so the About
 * dialog and the header badge can show it (even when the check ran at launch),
 * and runs the confirm-gated install — download, flush pending app state,
 * install — naming the confirmed version at each step. Installing restarts the
 * app and ends every live session. Checks run only when the user asks or opted
 * in to the launch check; the backend never contacts the update server on its
 * own.
 */

import { checkUpdate, downloadUpdate, installUpdate, type AppError, type UpdateInfo } from "../ipc";
import { confirm } from "../ui/confirm";
import { t } from "../i18n";

export interface UpdateControllerOptions {
	/** Persists anything pending before the app restarts (main.ts saves the tab layout). */
	beforeInstall: () => Promise<void>;
	/** Reports an install failure — shown even when the About dialog is closed. */
	onInstallError: (message: string) => void;
}

export class UpdateController {
	private found: UpdateInfo | null = null;
	private installing = false;
	/** The last install attempt failed (cleared by the next check). */
	private failed = false;
	/** The last successful check found nothing newer. */
	private upToDate = false;
	private readonly listeners = new Set<() => void>();

	constructor(private readonly options: UpdateControllerOptions) {}

	/** The release found by the last successful check, if any. */
	available(): UpdateInfo | null {
		return this.found;
	}

	/** Whether the last successful check found this build to be the latest.
	 * (The server names no version then, so there is no "latest" to show.) */
	isUpToDate(): boolean {
		return this.upToDate;
	}

	/** Whether an install is downloading or running. */
	isInstalling(): boolean {
		return this.installing;
	}

	/** Whether the last install attempt failed — the found release may be
	 * broken or gone, so the dialog offers a re-check and a manual download. */
	installFailed(): boolean {
		return this.failed;
	}

	/** Calls `listener` after every state change; returns an unsubscribe. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Asks the backend for a newer release. Rejects with an `AppError` on failure.
	 * While installing it doesn't re-check: that would replace the release being
	 * installed. */
	async check(): Promise<UpdateInfo | null> {
		if (this.installing) return this.found;
		this.found = await checkUpdate();
		this.upToDate = this.found === null;
		this.failed = false;
		this.emit();
		return this.found;
	}

	/** The startup check, only when the user opted in — the app contacts no
	 * server otherwise. A failure is logged, never surfaced: the user didn't
	 * just ask for anything. */
	async maybeCheckOnLaunch(enabled: boolean): Promise<UpdateInfo | null> {
		if (!enabled) return null;
		return this.check().catch((err: unknown) => {
			console.warn("Update check failed:", err);
			return null;
		});
	}

	/** Confirms, then installs the found release; on success the app restarts.
	 * Resolves `false` when there is nothing to install, one is already running,
	 * the user cancels, or it fails (reported via `onInstallError`). */
	async install(): Promise<boolean> {
		const info = this.installing ? null : this.found;
		if (!info || !(await this.confirmInstall(info))) return false;
		return this.runInstall(info.version);
	}

	private confirmInstall(info: UpdateInfo): Promise<boolean> {
		return confirm(t("updates.confirm.message", { version: info.version }), {
			title: t("updates.confirm.title"),
			confirmLabel: t("updates.install"),
		});
	}

	private async runInstall(version: string): Promise<boolean> {
		this.setInstalling(true);
		try {
			await downloadUpdate(version);
			await this.options.beforeInstall();
			await installUpdate(version);
			return true;
		} catch (err) {
			this.failed = true;
			this.options.onInstallError((err as AppError).message);
			return false;
		} finally {
			this.setInstalling(false);
		}
	}

	private setInstalling(installing: boolean): void {
		this.installing = installing;
		this.emit();
	}

	private emit(): void {
		this.listeners.forEach((listener) => listener());
	}
}
