import { describe, it, expect } from "vitest";
import { DirHistory } from "./dirHistory";

function visited(...paths: string[]): DirHistory {
  const history = new DirHistory();
  for (const path of paths) history.record(path);
  return history;
}

describe("DirHistory", () => {
  it("starts empty, with nowhere to go", () => {
    const history = new DirHistory();
    expect(history.canGoBack()).toBe(false);
    expect(history.canGoForward()).toBe(false);
    expect(history.backTarget()).toBeUndefined();
    expect(history.forwardTarget()).toBeUndefined();
  });

  it("goes back to the previous directory, then forward again", () => {
    const history = visited("/a", "/b");
    expect(history.backTarget()).toBe("/a");
    history.stepBack();
    expect(history.isCurrent("/a")).toBe(true);
    expect(history.forwardTarget()).toBe("/b");
    history.stepForward();
    expect(history.isCurrent("/b")).toBe(true);
    expect(history.canGoForward()).toBe(false);
  });

  it("drops the forward entries when a new directory is recorded", () => {
    const history = visited("/a", "/b", "/c");
    history.stepBack();
    history.record("/d");
    expect(history.canGoForward()).toBe(false);
    expect(history.backTarget()).toBe("/b");
  });

  it("only the cursor's directory is current", () => {
    const history = visited("/a", "/b");
    expect(history.isCurrent("/b")).toBe(true);
    expect(history.isCurrent("/a")).toBe(false);
  });

  it("forgets everything on reset", () => {
    const history = visited("/a", "/b");
    history.reset();
    expect(history.canGoBack()).toBe(false);
    expect(history.isCurrent("/b")).toBe(false);
  });

  it("stepping past either end is a no-op", () => {
    const history = visited("/a");
    history.stepBack();
    history.stepForward();
    expect(history.isCurrent("/a")).toBe(true);
  });
});
