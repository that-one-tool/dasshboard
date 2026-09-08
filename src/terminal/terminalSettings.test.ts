import { describe, it, expect } from "vitest";
import {
  DEFAULT_TERMINAL_SETTINGS,
  ICON_FONT,
  withIconFont,
  xtermThemeFor,
} from "./terminalSettings";

describe("xtermThemeFor", () => {
  it("maps dark to a dark background", () => {
    const t = xtermThemeFor("dark");
    expect(t.background).toBe("#1e1e1e");
    expect(t.foreground).toBe("#d4d4d4");
  });
  it("maps light to a light background", () => {
    const t = xtermThemeFor("light");
    expect(t.background).toBe("#ffffff");
    expect(t.foreground).toBe("#1e1e1e");
  });
});

describe("DEFAULT_TERMINAL_SETTINGS", () => {
  it("matches the backend defaults", () => {
    expect(DEFAULT_TERMINAL_SETTINGS.fontSize).toBe(14);
    expect(DEFAULT_TERMINAL_SETTINGS.theme).toBe("dark");
    expect(DEFAULT_TERMINAL_SETTINGS.fontFamily).toContain("Cascadia Mono");
  });
  it("does not store the icon font — it is injected at render time", () => {
    expect(DEFAULT_TERMINAL_SETTINGS.fontFamily).not.toContain(ICON_FONT);
  });
});

describe("withIconFont", () => {
  it("prepends the icon font to a user's chain", () => {
    expect(withIconFont('"Cascadia Mono", Consolas, monospace')).toBe(
      `${ICON_FONT}, "Cascadia Mono", Consolas, monospace`,
    );
  });
  it("prepends it to an arbitrary custom font", () => {
    expect(withIconFont("Fira Code")).toBe(`${ICON_FONT}, Fira Code`);
  });
  it("is idempotent when the icon font is already present", () => {
    const chain = `${ICON_FONT}, "Cascadia Mono", monospace`;
    expect(withIconFont(chain)).toBe(chain);
  });
});
