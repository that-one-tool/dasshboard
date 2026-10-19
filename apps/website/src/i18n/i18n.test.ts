import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { en } from "./en";
import { messagesFor } from "./index";
import { DEFAULT_LOCALE, HTML_LANG, LOCALE_NAMES, SUPPORTED_LOCALES, TRANSLATED_LOCALES, format, isSupportedLocale, localePath } from "./locales";

type Shape = "string" | Shape[] | { [key: string]: Shape };

function shapeOf(value: unknown): Shape {
	if (typeof value === "string") return "string";
	if (Array.isArray(value)) return value.map(shapeOf);
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
	return Object.fromEntries(entries.map(([key, child]) => [key, shapeOf(child)]));
}

function leaves(value: unknown, path = ""): [string, string][] {
	if (typeof value === "string") return [[path, value]];
	return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => leaves(child, `${path}.${key}`));
}

function readDesktopLocales(): string[] {
	const source = readFileSync("../desktop/src/i18n/index.ts", "utf8");
	const list = /SUPPORTED_LOCALES = \[([^\]]*)\]/.exec(source)?.[1];
	if (list === undefined) throw new Error("SUPPORTED_LOCALES not found in the desktop i18n");
	return [...list.matchAll(/"([\w-]+)"/g)].map((match) => match[1] ?? "");
}

function placeholders(text: string): string[] {
	return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "").sort();
}

describe("locales", () => {
	it("ships the desktop app's languages, English first", () => {
		expect(SUPPORTED_LOCALES).toEqual(["en", "fr", "es", "de", "it", "pt", "zh", "ja"]);
		expect(DEFAULT_LOCALE).toBe("en");
	});

	it("matches the desktop app's locale list exactly", () => {
		expect([...SUPPORTED_LOCALES]).toEqual(readDesktopLocales());
	});

	it("lists every non-default locale as translated", () => {
		expect(TRANSLATED_LOCALES).toEqual(["fr", "es", "de", "it", "pt", "zh", "ja"]);
	});

	it("names every locale and gives it an html lang", () => {
		for (const locale of SUPPORTED_LOCALES) {
			expect(LOCALE_NAMES[locale]).not.toBe("");
			expect(HTML_LANG[locale]).toMatch(/^[a-z]{2}(-[A-Za-z]+)?$/);
		}
	});

	it("recognises only shipped locales", () => {
		expect(isSupportedLocale("ja")).toBe(true);
		expect(isSupportedLocale("it")).toBe(true);
		expect(isSupportedLocale("ko")).toBe(false);
		expect(isSupportedLocale(undefined)).toBe(false);
	});
});

describe("localePath", () => {
	it("serves English at the site root", () => {
		expect(localePath("en", "/dasshboard")).toBe("/dasshboard/");
	});

	it("prefixes other locales", () => {
		expect(localePath("fr", "/dasshboard")).toBe("/dasshboard/fr/");
	});

	it("tolerates a trailing slash on the base", () => {
		expect(localePath("de", "/dasshboard/")).toBe("/dasshboard/de/");
		expect(localePath("en", "/")).toBe("/");
	});
});

describe("format", () => {
	it("fills named placeholders", () => {
		expect(format("Download v{version}", { version: "1.21.0" })).toBe("Download v1.21.0");
	});

	it("leaves unknown placeholders visible", () => {
		expect(format("{missing} here", {})).toBe("{missing} here");
	});
});

describe("message tables", () => {
	it("fills the language count from the shipped locales instead of hardcoding it", () => {
		const bodies = en.features.items.map((item) => item.body);
		expect(bodies.some((body) => body.includes("{languageCount}"))).toBe(true);
		expect(bodies.join(" ")).not.toMatch(/\d+ languages/);
	});

	it.each(TRANSLATED_LOCALES)("%s has exactly the English structure", (locale) => {
		expect(shapeOf(messagesFor(locale))).toEqual(shapeOf(en));
	});

	it.each(SUPPORTED_LOCALES)("%s has no empty message", (locale) => {
		for (const [path, text] of leaves(messagesFor(locale))) {
			expect(text.trim(), path).not.toBe("");
		}
	});

	it.each(TRANSLATED_LOCALES)("%s keeps every placeholder of the English source", (locale) => {
		const translated = new Map(leaves(messagesFor(locale)));
		for (const [path, text] of leaves(en)) {
			expect(placeholders(translated.get(path) ?? ""), path).toEqual(placeholders(text));
		}
	});
});
