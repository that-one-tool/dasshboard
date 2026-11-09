/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { blankToNull, inputChecked, inputInt, inputValue, setChecked, setInputValue } from "./formFields";

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement("div");
  root.innerHTML = `<input id="text" value=" 42 " /><input id="box" type="checkbox" checked />`;
});

describe("blankToNull", () => {
  it("trims, and turns blank into null", () => {
    expect(blankToNull("  hi ")).toBe("hi");
    expect(blankToNull("   ")).toBeNull();
  });
});

describe("readers", () => {
  it("read values, integers and checkboxes", () => {
    expect(inputValue(root, "#text")).toBe(" 42 ");
    expect(inputInt(root, "#text")).toBe(42);
    expect(inputChecked(root, "#box")).toBe(true);
  });

  it("throw when the input is missing", () => {
    expect(() => inputValue(root, "#missing")).toThrow("#missing");
  });
});

describe("writers", () => {
  it("set a value, with null/undefined as empty", () => {
    setInputValue(root, "#text", 7);
    expect(inputValue(root, "#text")).toBe("7");
    setInputValue(root, "#text", null);
    expect(inputValue(root, "#text")).toBe("");
  });

  it("set a checkbox, with undefined as unchecked", () => {
    setChecked(root, "#box", undefined);
    expect(inputChecked(root, "#box")).toBe(false);
    setChecked(root, "#box", true);
    expect(inputChecked(root, "#box")).toBe(true);
  });

  it("skip a missing input", () => {
    expect(() => {
      setInputValue(root, "#missing", "x");
      setChecked(root, "#missing", true);
    }).not.toThrow();
  });
});
