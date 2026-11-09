import { describe, expect, it } from "vitest";
import entry from "./styles.css?raw";

const parts = import.meta.glob<string>("./styles/*.css", {
	query: "?raw",
	import: "default",
	eager: true,
});

// The cascade depends on this order: later parts win specificity ties.
const EXPECTED_ORDER = [
	"fonts",
	"tokens",
	"app-layout",
	"sidebar",
	"workspace",
	"tabs",
	"grid",
	"terminal-pane",
	"buttons",
	"sidebar-rail",
	"dialog",
	"forms",
	"toast",
	"scrollbars",
	"profiles",
	"icons",
	"settings",
	"about",
	"known-hosts",
	"port-forwards",
	"tunnels",
	"selects",
	"sftp",
	"interactions",
	"commands",
];

function readImportedParts(css: string): string[] {
	return [...css.matchAll(/@import ["']\.\/styles\/(.+?)\.css["'];/g)].map((match) => match[1] ?? "");
}

function listPartFiles(): string[] {
	return Object.keys(parts).map((path) => path.replace("./styles/", "").replace(/\.css$/, ""));
}

describe("styles.css entry", () => {
	it("imports the parts in the cascade order", () => {
		expect(readImportedParts(entry)).toEqual(EXPECTED_ORDER);
	});

	it("imports every part file exactly once", () => {
		expect(listPartFiles().sort()).toEqual([...EXPECTED_ORDER].sort());
	});

	it("reads the part sources, not empty stubs", () => {
		expect(Object.values(parts).every((css) => css.length > 0)).toBe(true);
	});
});
