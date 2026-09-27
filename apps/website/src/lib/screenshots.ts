// Screenshots are optional drop-ins: a file named after its slot in
// src/assets/screenshots/ (e.g. `sftp.webp`) replaces that slot's CSS mockup.
export const SCREENSHOT_SLOTS = ["hero", "grid", "sftp", "tunnels", "broadcast"] as const;

export type ScreenshotSlot = (typeof SCREENSHOT_SLOTS)[number];

function fileStem(path: string): string {
	const fileName = path.slice(path.lastIndexOf("/") + 1);
	return fileName.replace(/\.[^.]+$/, "");
}

export function findScreenshot<T>(slot: ScreenshotSlot, modules: Record<string, { default: T }>): T | undefined {
	const match = Object.entries(modules).find(([path]) => fileStem(path) === slot);
	return match?.[1].default;
}

const STANDARD_WIDTHS = [480, 960, 1440];

// srcset widths for a screenshot: never wider than the file itself.
export function responsiveWidths(originalWidth: number): number[] {
	return [...STANDARD_WIDTHS.filter((width) => width < originalWidth), originalWidth];
}
