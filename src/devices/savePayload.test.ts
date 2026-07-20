import { describe, it, expect } from "vitest";
import { decideSecretToSend } from "./savePayload";

describe("decideSecretToSend", () => {
  it("returns undefined when the secret field is empty (untouched)", () => {
    const result = decideSecretToSend("");
    expect(result).toBeUndefined();
  });

  it("returns the secret when the user typed one", () => {
    const result = decideSecretToSend("my-password");
    expect(result).toBe("my-password");
  });

  describe("special characters and edge cases", () => {
    it("preserves whitespace in secret", () => {
      const result = decideSecretToSend("pass word with spaces");
      expect(result).toBe("pass word with spaces");
    });

    it("handles secrets with special characters", () => {
      const result = decideSecretToSend("p@$$w0rd!#%&*");
      expect(result).toBe("p@$$w0rd!#%&*");
    });

    it("handles very long secrets", () => {
      const longSecret = "a".repeat(10000);
      const result = decideSecretToSend(longSecret);
      expect(result).toBe(longSecret);
    });
  });
});
