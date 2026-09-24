/**
 * Smoke test for the static icon glyphs (F9). Each exported icon is inert SVG
 * markup injected via `innerHTML` at call sites — this guards that every export
 * is a well-formed `<svg>` string (catching a copy-paste mistake: an empty
 * export, a stray unclosed tag) and that the whole set follows one convention:
 * Lucide's 24-unit grid, 2-unit `currentColor` stroke, one size per role.
 */

import { describe, it, expect } from "vitest";
import * as icons from "./icons";

/** The top-bar action icons, drawn larger than the in-list / toolbar glyphs. */
const HEADER_ICONS = new Set(["helpIcon", "reloadIcon", "lockIcon", "gearIcon", "filesIcon"]);

/** "On" states drawn as a filled shape rather than an outline. */
const FILLED_ICONS = new Set(["starFillIcon", "bookmarkFilledIcon"]);

describe("icons", () => {
  for (const [name, svg] of Object.entries(icons)) {
    it(`${name} is a non-empty, well-formed <svg> string`, () => {
      expect(typeof svg).toBe("string");
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg.trim().endsWith("</svg>")).toBe(true);
      expect(svg).toContain('aria-hidden="true"');
    });

    it(`${name} is a 2px currentColor stroke icon on the 24-unit grid`, () => {
      expect(svg).toContain('viewBox="0 0 24 24"');
      expect(svg).toContain('stroke="currentColor"');
      expect(svg).toContain('stroke-width="2"');
    });

    it(`${name} is sized for its role`, () => {
      const size = HEADER_ICONS.has(name) ? 18 : 16;
      expect(svg).toContain(`width="${size}" height="${size}"`);
    });

    it(`${name} is ${FILLED_ICONS.has(name) ? "filled" : "an outline"}`, () => {
      const fill = FILLED_ICONS.has(name) ? "currentColor" : "none";
      expect(svg).toContain(`fill="${fill}"`);
    });
  }
});
