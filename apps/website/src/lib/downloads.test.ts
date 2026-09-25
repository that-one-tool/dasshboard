import { describe, expect, it } from "vitest";
import { downloadInfo } from "./downloads";

describe("downloadInfo", () => {
	it("points installers at the CrabNebula releases page", () => {
		expect(downloadInfo("1.20.0").installersUrl).toBe("https://web.crabnebula.cloud/that-one-tool/dasshboard/releases/");
	});

	it("links the release notes of the given version's GitHub tag", () => {
		expect(downloadInfo("1.20.0").releaseNotesUrl).toBe("https://github.com/that-one-tool/dasshboard/releases/tag/v1.20.0");
	});

	it("carries the version for display", () => {
		expect(downloadInfo("1.20.0").version).toBe("1.20.0");
	});
});
