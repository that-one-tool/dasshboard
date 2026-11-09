import { describe, it, expect, vi } from "vitest";
import { deviceFeedback } from "./deviceFeedback";

describe("deviceFeedback", () => {
  it("forwards errors and successes to the callbacks", () => {
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const feedback = deviceFeedback({ onError, onSuccess });
    feedback.error({ code: "Io", message: "boom" });
    feedback.success("saved");
    expect(onError).toHaveBeenCalledWith({ code: "Io", message: "boom" });
    expect(onSuccess).toHaveBeenCalledWith("saved");
  });

  it("is a no-op without callbacks", () => {
    const feedback = deviceFeedback({});
    expect(() => {
      feedback.error(new Error("x"));
      feedback.success("y");
    }).not.toThrow();
  });

  it("reads the callback at call time", () => {
    const options: { onSuccess?: (message: string) => void } = {};
    const feedback = deviceFeedback(options);
    options.onSuccess = vi.fn();
    feedback.success("late");
    expect(options.onSuccess).toHaveBeenCalledWith("late");
  });
});
