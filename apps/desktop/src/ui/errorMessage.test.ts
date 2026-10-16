import { describe, it, expect } from "vitest";
import { getErrorMessage } from "./errorMessage";

describe("getErrorMessage", () => {
  it("reads an AppError's or an Error's message", () => {
    expect(getErrorMessage({ code: "Io", message: "disk gone" })).toBe("disk gone");
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies anything without a string message", () => {
    expect(getErrorMessage("plain")).toBe("plain");
    expect(getErrorMessage(null)).toBe("null");
    expect(getErrorMessage(undefined)).toBe("undefined");
    expect(getErrorMessage(42)).toBe("42");
    expect(getErrorMessage({ message: 7 })).toBe("[object Object]");
  });

  it("ignores a message on something that is not an object", () => {
    const withMessage = Object.assign(() => {}, { message: "m" });
    expect(getErrorMessage(withMessage)).toBe(String(withMessage));
  });
});
