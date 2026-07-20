import { describe, it, expect } from "vitest";
import { DEFAULT_TERMINAL_SETTINGS, xtermThemeFor } from "./terminalSettings";

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
});
