/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from "vitest";
import { createOption, isDialogOpen, listen, remToPx, requireEl } from "./dom";

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

describe("remToPx", () => {
  it("converts with the root font size", () => {
    document.documentElement.style.fontSize = "20px";
    try {
      expect(remToPx(2)).toBe(40);
    } finally {
      document.documentElement.style.fontSize = "";
    }
  });

  it("uses the 16px default when the root has no explicit size", () => {
    expect(remToPx(1.5)).toBe(24);
  });
});

describe("isDialogOpen", () => {
  it("is true only while a dialog is shown, not while one sits hidden in the DOM", () => {
    document.body.innerHTML = `<div class="dialog dialog-hidden"></div>`;
    expect(isDialogOpen()).toBe(false);
    document.body.insertAdjacentHTML("beforeend", `<div class="dialog confirm-dialog"></div>`);
    expect(isDialogOpen()).toBe(true);
  });
});

describe("listen", () => {
  it("adds the listener to the first match under root", () => {
    const root = document.createElement("div");
    root.innerHTML = `<button class="a">1</button><button class="a">2</button>`;
    const seen: string[] = [];
    listen(root, ".a", "click", (e) => seen.push((e.target as HTMLElement).textContent ?? ""));
    root.querySelectorAll<HTMLElement>(".a").forEach((button) => button.click());
    expect(seen).toEqual(["1"]);
  });

  it("does nothing when no element matches", () => {
    const root = document.createElement("div");
    expect(() => listen(root, ".missing", "click", () => {})).not.toThrow();
  });
});

describe("createOption", () => {
  it("builds an option with the value and text (not markup)", () => {
    const option = createOption("v1", "<b>Label</b>");
    expect(option.value).toBe("v1");
    expect(option.textContent).toBe("<b>Label</b>");
    expect(option.querySelector("b")).toBeNull();
  });
});
