// Installers are hosted on CrabNebula Cloud; the GitHub release (tag vX.Y.Z)
// only carries the generated release notes.
const INSTALLERS_URL = "https://web.crabnebula.cloud/that-one-tool/dasshboard/releases/";
const GITHUB_RELEASES_URL = "https://github.com/that-one-tool/dasshboard/releases";

export interface DownloadInfo {
	version: string;
	installersUrl: string;
	releaseNotesUrl: string;
}

export function downloadInfo(version: string): DownloadInfo {
	return {
		version,
		installersUrl: INSTALLERS_URL,
		releaseNotesUrl: `${GITHUB_RELEASES_URL}/tag/v${version}`,
	};
}
