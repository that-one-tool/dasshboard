import { describe, expect, it } from "vitest";
import { findScreenshot, responsiveWidths } from "./screenshots";

const modules = {
	"../assets/screenshots/grid.webp": { default: "grid-image" },
	"../assets/screenshots/sftp.png": { default: "sftp-image" },
};

describe("findScreenshot", () => {
	it("returns the image whose file name is the slot", () => {
		expect(findScreenshot("grid", modules)).toBe("grid-image");
		expect(findScreenshot("sftp", modules)).toBe("sftp-image");
	});

	it("returns undefined when no file fills the slot", () => {
		expect(findScreenshot("tunnels", modules)).toBeUndefined();
	});

	it("matches the whole file name, not a prefix", () => {
		expect(findScreenshot("grid", { "../assets/screenshots/grid-old.png": { default: "old" } })).toBeUndefined();
	});
});

describe("responsiveWidths", () => {
	it("keeps the standard widths below the original and adds the original", () => {
		expect(responsiveWidths(1600)).toEqual([480, 960, 1440, 1600]);
	});

	it("never upscales a small screenshot", () => {
		expect(responsiveWidths(800)).toEqual([480, 800]);
	});

	it("does not repeat a width equal to the original", () => {
		expect(responsiveWidths(960)).toEqual([480, 960]);
	});
});
