import { describe, it, expect } from "vitest";
import { PromptQueue } from "./promptQueue";

const prompt = (promptId: string) => ({ promptId });

describe("PromptQueue", () => {
  it("shows the first prompt at once and queues the rest", () => {
    const queue = new PromptQueue<{ promptId: string }>();
    expect(queue.push(prompt("a"))).toBe(true);
    expect(queue.push(prompt("b"))).toBe(false);
    expect(queue.current?.promptId).toBe("a");
  });

  it("advances in arrival order, then runs empty", () => {
    const queue = new PromptQueue<{ promptId: string }>();
    queue.push(prompt("a"));
    queue.push(prompt("b"));
    expect(queue.advance()?.promptId).toBe("b");
    expect(queue.advance()).toBeNull();
    expect(queue.current).toBeNull();
    expect(queue.push(prompt("c"))).toBe(true);
  });

  it("dropping the shown prompt moves to the next one", () => {
    const queue = new PromptQueue<{ promptId: string }>();
    queue.push(prompt("a"));
    queue.push(prompt("b"));
    expect(queue.drop("a")).toBe(true);
    expect(queue.current?.promptId).toBe("b");
  });

  it("dropping a queued prompt leaves the shown one alone", () => {
    const queue = new PromptQueue<{ promptId: string }>();
    queue.push(prompt("a"));
    queue.push(prompt("b"));
    queue.push(prompt("c"));
    expect(queue.drop("b")).toBe(false);
    expect(queue.current?.promptId).toBe("a");
    expect(queue.advance()?.promptId).toBe("c");
  });
});
