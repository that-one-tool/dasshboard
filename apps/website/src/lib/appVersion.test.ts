import { describe, expect, it } from "vitest";
import { parseAppVersion, readAppVersion } from "./appVersion";

describe("parseAppVersion", () => {
	it("returns the version from a tauri.conf.json document", () => {
		expect(parseAppVersion('{ "productName": "DaSSHboard", "version": "1.20.0" }')).toBe("1.20.0");
	});

	it("accepts a pre-release suffix", () => {
		expect(parseAppVersion('{ "version": "2.0.0-beta.1" }')).toBe("2.0.0-beta.1");
	});

	it("throws when the version is missing", () => {
		expect(() => parseAppVersion('{ "productName": "DaSSHboard" }')).toThrow(/version/);
	});

	it("throws when the version is not semver", () => {
		expect(() => parseAppVersion('{ "version": "latest" }')).toThrow(/latest/);
	});

	it("throws on malformed JSON", () => {
		expect(() => parseAppVersion("{ not json")).toThrow();
	});
});

describe("readAppVersion", () => {
	it("reads the desktop app's real tauri.conf.json", () => {
		expect(readAppVersion()).toMatch(/^\d+\.\d+\.\d+/);
	});
});
