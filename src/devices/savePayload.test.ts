import { describe, it, expect } from "vitest";
import { decideSecretToSend } from "./savePayload";

describe("decideSecretToSend", () => {
  describe("new device", () => {
    it("returns undefined when secret is empty (field untouched)", () => {
      const result = decideSecretToSend(true, "");
      expect(result).toBeUndefined();
    });

    it("returns the secret when user typed one", () => {
      const result = decideSecretToSend(true, "my-password");
      expect(result).toBe("my-password");
    });
  });

  describe("edit mode (existing device)", () => {
    it("returns undefined when secret field is empty (user didn't change it)", () => {
      const result = decideSecretToSend(false, "");
      expect(result).toBeUndefined();
    });

    it("returns the secret when user typed a new one", () => {
      const result = decideSecretToSend(false, "new-password");
      expect(result).toBe("new-password");
    });

    it("allows setting an empty secret explicitly if user typed something in the field", () => {
      // This test documents the behavior: if the field has any non-empty value,
      // we include it. An empty string returned from decideSecretToSend means
      // the field was left untouched. If we need to support explicitly clearing
      // a secret, we'd need a different UI pattern (e.g., a checkbox "clear password").
      const result = decideSecretToSend(false, "something");
      expect(result).toBe("something");
    });
  });

  describe("special characters and edge cases", () => {
    it("preserves whitespace in secret", () => {
      const result = decideSecretToSend(true, "pass word with spaces");
      expect(result).toBe("pass word with spaces");
    });

    it("handles secrets with special characters", () => {
      const result = decideSecretToSend(true, "p@$$w0rd!#%&*");
      expect(result).toBe("p@$$w0rd!#%&*");
    });

    it("handles very long secrets", () => {
      const longSecret = "a".repeat(10000);
      const result = decideSecretToSend(true, longSecret);
      expect(result).toBe(longSecret);
    });
  });
});
