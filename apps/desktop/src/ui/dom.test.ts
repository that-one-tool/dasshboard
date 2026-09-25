/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from "vitest";
import { requireEl } from "./dom";

describe("requireEl", () => {
  it("returns the matching element, typed as requested", () => {
    const root = document.createElement("div");
    root.innerHTML = `<input id="name" value="hi" />`;
    const input = requireEl<HTMLInputElement>(root, "#name");
    expect(input.value).toBe("hi");
  });

  it("throws with the selector when the element is missing", () => {
    const root = document.createElement("div");
    expect(() => requireEl(root, ".nope")).toThrow(
      "Expected element not found: .nope",
    );
  });

  it("searches within the given root only", () => {
    document.body.innerHTML = `<span class="outside"></span>`;
    const root = document.createElement("div");
    // `.outside` exists in the document but not under `root`.
    expect(() => requireEl(root, ".outside")).toThrow();
  });
});
