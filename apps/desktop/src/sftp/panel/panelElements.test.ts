/** @vitest-environment happy-dom */
import { describe, it, expect } from "vitest";
import { buildPanelElements } from "./panelElements";

describe("buildPanelElements", () => {
  it("renders the markup into the root and finds every control in it", () => {
    const root = document.createElement("aside");
    const els = buildPanelElements(root);

    expect(els.root).toBe(root);
    for (const element of Object.values(els)) {
      expect(root === element || root.contains(element)).toBe(true);
    }
    expect(els.deviceSelect.tagName).toBe("SELECT");
    expect(els.back.dataset.action).toBe("back");
    expect(els.selectAll.dataset.action).toBe("select-all");
  });

  it("replaces whatever the root held before (a rebuild)", () => {
    const root = document.createElement("aside");
    const first = buildPanelElements(root);
    const second = buildPanelElements(root);

    expect(second.list).not.toBe(first.list);
    expect(root.querySelectorAll(".sftp-entries").length).toBe(1);
  });
});
