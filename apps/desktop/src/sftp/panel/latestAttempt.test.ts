import { describe, it, expect } from "vitest";
import { LatestAttempt } from "./latestAttempt";

describe("LatestAttempt", () => {
  it("keeps only the newest attempt current", () => {
    const attempts = new LatestAttempt();
    const first = attempts.begin();
    expect(attempts.isCurrent(first)).toBe(true);
    const second = attempts.begin();
    expect(attempts.isCurrent(first)).toBe(false);
    expect(attempts.isCurrent(second)).toBe(true);
  });

  it("makes the attempt in flight stale on invalidate", () => {
    const attempts = new LatestAttempt();
    const attempt = attempts.begin();
    attempts.invalidate();
    expect(attempts.isCurrent(attempt)).toBe(false);
  });
});
