import { describe, it, expect, vi } from "vitest";
import { findFreeName, MAX_FREE_NAME_TRIES } from "./freeName";

const existing = (...paths: string[]) => async (path: string) => paths.includes(path);

describe("findFreeName", () => {
  it("numbers the name from (2) up to the first one not taken", async () => {
    expect(await findFreeName("/x", existing("/x (2)"))).toBe("/x (3)");
  });

  it("starts at (2): the path itself is known to be taken", async () => {
    expect(await findFreeName("/x", existing())).toBe("/x (2)");
  });

  it("gives up with null after the maximum number of tries", async () => {
    const exists = vi.fn(async () => true);
    expect(await findFreeName("/x", exists)).toBeNull();
    expect(exists).toHaveBeenCalledTimes(MAX_FREE_NAME_TRIES);
    expect(exists).toHaveBeenLastCalledWith(`/x (${MAX_FREE_NAME_TRIES + 1})`);
  });
});
