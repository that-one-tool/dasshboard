/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PRESET_IDS } from "../gridModel";
import { markActivePreset, renderGridToolbar, setPresetButtonsDisabled, showBroadcastButton } from "./gridToolbar";

let toolbar: HTMLElement;
const handlers = { onPreset: vi.fn(), onBroadcast: vi.fn() };

function presets(): HTMLButtonElement[] {
  return [...toolbar.querySelectorAll<HTMLButtonElement>(".grid-preset-btn")];
}

beforeEach(() => {
  toolbar = document.createElement("div");
  handlers.onPreset.mockReset();
  handlers.onBroadcast.mockReset();
  renderGridToolbar(toolbar, handlers);
});

describe("renderGridToolbar", () => {
  it("renders a label, one button per preset, then the broadcast toggle", () => {
    expect(toolbar.firstElementChild?.className).toBe("grid-toolbar-label");
    expect(presets().map((b) => b.dataset.preset)).toEqual([...PRESET_IDS]);
    expect(toolbar.lastElementChild?.classList.contains("grid-broadcast-btn")).toBe(true);
  });

  it("routes preset and broadcast clicks", () => {
    presets()[1]?.click();
    toolbar.querySelector<HTMLButtonElement>(".grid-broadcast-btn")?.click();
    expect(handlers.onPreset).toHaveBeenCalledWith(PRESET_IDS[1]);
    expect(handlers.onBroadcast).toHaveBeenCalledTimes(1);
  });

  it("replaces the previous buttons on a re-render", () => {
    renderGridToolbar(toolbar, handlers);
    expect(presets()).toHaveLength(PRESET_IDS.length);
  });
});

describe("toolbar state", () => {
  it("highlights only the active preset, none for a custom shape", () => {
    markActivePreset(toolbar, PRESET_IDS[0]!);
    expect(presets().filter((b) => b.classList.contains("grid-preset-active"))).toEqual([presets()[0]]);
    markActivePreset(toolbar, null);
    expect(toolbar.querySelector(".grid-preset-active")).toBeNull();
  });

  it("disables and re-enables the preset buttons", () => {
    setPresetButtonsDisabled(toolbar, true);
    expect(presets().every((b) => b.disabled)).toBe(true);
    setPresetButtonsDisabled(toolbar, false);
    expect(presets().some((b) => b.disabled)).toBe(false);
  });

  it("shows the broadcast toggle's pressed state", () => {
    const toggle = toolbar.querySelector<HTMLButtonElement>(".grid-broadcast-btn")!;
    showBroadcastButton(toolbar, true);
    expect(toggle.classList.contains("grid-broadcast-active")).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    showBroadcastButton(toolbar, false);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(() => showBroadcastButton(document.createElement("div"), true)).not.toThrow();
  });
});
