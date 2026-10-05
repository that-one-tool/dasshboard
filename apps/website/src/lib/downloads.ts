// Installers are hosted on CrabNebula Cloud; the GitHub release (tag vX.Y.Z)
// only carries the generated release notes.
const INSTALLERS_URL = "https://web.crabnebula.cloud/that-one-tool/dasshboard/releases/";
const GITHUB_RELEASES_URL = "https://github.com/that-one-tool/dasshboard/releases";
// The desktop release workflow builds the signed Flatpak repo and site-deploy
// serves it from this site's flatpak/ folder. Absolute: it goes into a command.
const FLATPAK_REF_URL = "https://that-one-tool.github.io/dasshboard/flatpak/dasshboard.flatpakref";

export interface DownloadInfo {
	version: string;
	installersUrl: string;
	releaseNotesUrl: string;
	flatpakRefUrl: string;
}

export function downloadInfo(version: string): DownloadInfo {
	return {
		version,
		installersUrl: INSTALLERS_URL,
		releaseNotesUrl: `${GITHUB_RELEASES_URL}/tag/v${version}`,
		flatpakRefUrl: FLATPAK_REF_URL,
	};
}
