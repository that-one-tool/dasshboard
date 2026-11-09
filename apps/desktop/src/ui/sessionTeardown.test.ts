/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, afterEach } from "vitest";
import { shrinkConfirmMessage } from "../gridModel";
import { confirmSessionTeardown } from "./sessionTeardown";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("confirmSessionTeardown", () => {
  it("asks with the live-session count, as a danger action", async () => {
    const answer = confirmSessionTeardown(2);
    expect(document.querySelector(".confirm-message")?.textContent).toBe(shrinkConfirmMessage(2));
    const accept = document.querySelector<HTMLButtonElement>('[data-action="confirm"]')!;
    expect(accept.classList.contains("btn-danger")).toBe(true);
    accept.click();
    await expect(answer).resolves.toBe(true);
  });

  it("resolves false when cancelled", async () => {
    const answer = confirmSessionTeardown(1);
    document.querySelector<HTMLButtonElement>('[data-action="cancel"]')!.click();
    await expect(answer).resolves.toBe(false);
  });
});
