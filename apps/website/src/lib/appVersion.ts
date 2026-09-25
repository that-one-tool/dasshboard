import { readFileSync } from "node:fs";

// The desktop app's tauri.conf.json is the canonical release version (the
// release workflow's check-versions job enforces it), so the site shows exactly
// what CrabNebula ships. Resolved from the website root: builds and tests both
// run from apps/website.
const TAURI_CONF_PATH = "../desktop/src-tauri/tauri.conf.json";
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function parseAppVersion(tauriConfJson: string): string {
	const version: unknown = JSON.parse(tauriConfJson).version;
	if (typeof version !== "string") {
		throw new Error("tauri.conf.json has no string `version` field");
	}
	if (!SEMVER.test(version)) {
		throw new Error(`tauri.conf.json version "${version}" is not semver`);
	}
	return version;
}

export function readAppVersion(path: string = TAURI_CONF_PATH): string {
	return parseAppVersion(readFileSync(path, "utf8"));
}
