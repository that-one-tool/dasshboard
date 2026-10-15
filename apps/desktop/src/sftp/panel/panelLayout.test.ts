import { describe, it, expect } from "vitest";
import { PanelLayout } from "./panelLayout";

const bounds = { min: 300, max: 1000 };
const saved = { open: true, collapsed: true, width: 500, deviceId: "a" };

describe("PanelLayout", () => {
  it("persists nothing until the panel was first opened", () => {
    const layout = new PanelLayout(360);
    expect(layout.persisted("a")).toBeUndefined();
    layout.show();
    expect(layout.persisted("a")).toEqual({ open: true, collapsed: false, width: 360, deviceId: "a" });
  });

  it("restores a saved open state", () => {
    const layout = new PanelLayout(360);
    expect(layout.restore(saved, bounds)).toBe(true);
    expect(layout.isOpen()).toBe(true);
    expect(layout.isCollapsed()).toBe(true);
    expect(layout.persisted(null)).toEqual({ ...saved, deviceId: null });
  });

  it("restores a closed panel's width only", () => {
    const layout = new PanelLayout(360);
    expect(layout.restore({ ...saved, open: false }, bounds)).toBe(false);
    expect(layout.isOpen()).toBe(false);
    expect(layout.width()).toBe(500);
    expect(layout.persisted("a")).toBeUndefined();
  });

  it("clamps a restored width into the bounds", () => {
    const narrow = new PanelLayout(360);
    narrow.restore({ ...saved, width: 10 }, bounds);
    expect(narrow.width()).toBe(300);
    const wide = new PanelLayout(360);
    wide.restore({ ...saved, width: 5000 }, bounds);
    expect(wide.width()).toBe(1000);
  });

  it("opens expanded", () => {
    const layout = new PanelLayout(360);
    layout.restore(saved, bounds);
    layout.show();
    expect(layout.isCollapsed()).toBe(false);
  });

  it("collapses only while open", () => {
    const layout = new PanelLayout(360);
    expect(layout.setCollapsed(true)).toBe(false);
    expect(layout.isCollapsed()).toBe(false);
    layout.show();
    expect(layout.setCollapsed(true)).toBe(true);
    expect(layout.isCollapsed()).toBe(true);
  });

  it("keeps the collapse state when hidden", () => {
    const layout = new PanelLayout(360);
    layout.show();
    layout.setCollapsed(true);
    layout.hide();
    expect(layout.isOpen()).toBe(false);
    expect(layout.persisted("a")).toEqual({ open: false, collapsed: true, width: 360, deviceId: "a" });
  });

  it("takes a dragged width", () => {
    const layout = new PanelLayout(360);
    layout.resize(420);
    expect(layout.width()).toBe(420);
  });
});
