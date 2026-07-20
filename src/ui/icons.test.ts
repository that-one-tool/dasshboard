/**
 * Smoke test for the static icon glyphs (F9). Each exported icon is inert SVG
 * markup injected via `innerHTML` at call sites — this just guards that every
 * export is present and looks like a well-formed `<svg>` string, catching a
 * copy-paste mistake (an empty export, a stray unclosed tag) without needing
 * a DOM environment.
 */

import { describe, it, expect } from "vitest";
import { pencilIcon, trashIcon, starFillIcon, starIcon } from "./icons";

describe("icons", () => {
  const icons = { pencilIcon, trashIcon, starFillIcon, starIcon };

  for (const [name, svg] of Object.entries(icons)) {
    it(`${name} is a non-empty, well-formed <svg> string`, () => {
      expect(typeof svg).toBe("string");
      expect(svg.length).toBeGreaterThan(0);
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg.trim().endsWith("</svg>")).toBe(true);
      expect(svg).toContain("viewBox=");
      expect(svg).toContain('fill="currentColor"');
    });
  }
});
