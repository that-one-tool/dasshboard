/**
 * The update part of the About dialog: a Check for updates button, a
 * status line, the release date and notes, and — once a newer release is known — Check
 * is replaced by either Install & restart (Windows installers, Linux AppImage)
 * or a Download link to the website (a .deb/.rpm install can't replace
 * itself). After a failed install, Check comes back (the release may have been
 * pulled) along with a link to download it manually. Renders from the
 * controller's state and follows its changes, so it is right even when the
 * dialog is reopened mid-install.
 */

import type { AppError, UpdateInfo } from "../ipc";
import type { UpdateController } from "./updateController";
import { getLocale, t } from "../i18n";

/** Where a notify-only build sends the user for the new installer. */
export const DOWNLOAD_PAGE_URL = "https://that-one-tool.github.io/dasshboard/#download";

/** Every published build, for a manual download when the in-app install fails. */
export const RELEASES_URL = "https://web.crabnebula.cloud/that-one-tool/dasshboard/releases";

interface SectionElements {
	status: HTMLElement;
	date: HTMLElement;
	notes: HTMLElement;
	check: HTMLButtonElement;
	install: HTMLButtonElement;
	download: HTMLAnchorElement;
	releases: HTMLAnchorElement;
}

/** Renders the update block into `container`, wired to `updates`. Returns the
 * unmount (stops following the controller). */
export function mountUpdateSection(container: HTMLElement, updates: UpdateController): () => void {
	container.innerHTML = `
    <div class="about-update">
      <div class="about-update-row">
        <div class="about-update-text">
          <p class="about-update-status" aria-live="polite"></p>
          <p class="about-update-date" hidden></p>
        </div>
        <div class="about-update-actions">
          <button type="button" class="btn btn-secondary" data-update="check">${t("updates.check")}</button>
          <button type="button" class="btn btn-primary" data-update="install" hidden>${t("updates.install")}</button>
          <a class="btn btn-primary" data-update="download" href="${DOWNLOAD_PAGE_URL}" target="_blank" hidden>${t("updates.download")}</a>
          <a class="btn btn-secondary" data-update="releases" href="${RELEASES_URL}" target="_blank" hidden>${t("updates.releasesLink")}</a>
        </div>
      </div>
      <p class="about-update-notes" hidden></p>
    </div>
  `;
	const els = sectionElements(container);
	render(els, updates);
	els.check.addEventListener("click", () => void runCheck(els, updates));
	els.install.addEventListener("click", () => void runInstall(els, updates));
	return updates.subscribe(() => render(els, updates));
}

function sectionElements(container: HTMLElement): SectionElements {
	const q = <T extends HTMLElement>(selector: string): T => container.querySelector<T>(selector) as T;
	return {
		status: q(".about-update-status"),
		date: q(".about-update-date"),
		notes: q(".about-update-notes"),
		check: q('[data-update="check"]'),
		install: q('[data-update="install"]'),
		download: q('[data-update="download"]'),
		releases: q('[data-update="releases"]'),
	};
}

/** Reflects the controller's state, status line included (leaving it alone
 * only when there is nothing to say). */
function render(els: SectionElements, updates: UpdateController): void {
	renderControls(els, updates);
	const status = statusFor(updates);
	if (status !== null) els.status.textContent = status;
}

/** Everything but the status line — used after a check, whose own message
 * ("up to date", an error) must stay visible. */
function renderControls(els: SectionElements, updates: UpdateController): void {
	showRelease(els, updates.available());
	showFailureRecovery(els, updates.installFailed());
	els.check.disabled = updates.isInstalling();
	els.install.disabled = updates.isInstalling();
}

function showRelease(els: SectionElements, info: UpdateInfo | null): void {
	showReleaseDate(els.date, info?.pubDate);
	els.notes.textContent = info?.notes ?? "";
	els.notes.hidden = !info?.notes;
	// A known release's action (Install or Download) takes Check's place.
	els.check.hidden = info !== null;
	els.install.hidden = !info?.canInstall;
	els.download.hidden = !info || info.canInstall;
}

function showReleaseDate(el: HTMLElement, pubDate: string | null | undefined): void {
	const date = formatReleaseDate(pubDate);
	el.textContent = date === null ? "" : t("updates.released", { date });
	el.hidden = date === null;
}

/** The publish date in the UI language, or `null` when absent or unreadable. */
function formatReleaseDate(pubDate: string | null | undefined): string | null {
	const date = new Date(pubDate ?? "");
	if (Number.isNaN(date.getTime())) return null;
	return new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium" }).format(date);
}

/** After a failed install: Check again (the release may be gone) and a link to
 * download a build by hand. */
function showFailureRecovery(els: SectionElements, failed: boolean): void {
	if (failed) els.check.hidden = false;
	els.releases.hidden = !failed;
}

function statusFor(updates: UpdateController): string | null {
	if (updates.isInstalling()) return t("updates.installing");
	const info = updates.available();
	if (info) return availableText(info);
	return updates.isUpToDate() ? t("updates.upToDate") : null;
}

function availableText(info: UpdateInfo): string {
	const available = t("updates.available", { version: info.version });
	return info.canInstall ? available : `${available} ${t("updates.notifyOnly")}`;
}

async function runCheck(els: SectionElements, updates: UpdateController): Promise<void> {
	els.check.disabled = true;
	els.status.textContent = t("updates.checking");
	try {
		const info = await updates.check();
		if (!info) els.status.textContent = t("updates.upToDate");
	} catch (err) {
		els.status.textContent = t("updates.checkFailed", { message: (err as AppError).message });
	} finally {
		renderControls(els, updates);
	}
}

async function runInstall(els: SectionElements, updates: UpdateController): Promise<void> {
	els.install.disabled = true;
	// On success the app restarts; a cancel or failure (toasted by the
	// controller) lands back here.
	await updates.install();
	render(els, updates);
}
