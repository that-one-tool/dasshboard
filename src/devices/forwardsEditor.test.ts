/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { Forward } from "../ipc";
import { ForwardsEditor } from "./forwardsEditor";

function makeContainer(): HTMLElement {
  document.body.innerHTML = '<div id="host"></div>';
  return document.querySelector<HTMLElement>("#host")!;
}

function sampleForward(overrides: Partial<Forward> = {}): Forward {
  return {
    id: "f1",
    name: "Postgres",
    localAddr: "127.0.0.1",
    localPort: 5432,
    remoteHost: "db.internal",
    remotePort: 5432,
    ...overrides,
  };
}

describe("ForwardsEditor", () => {
  let container: HTMLElement;
  let editor: ForwardsEditor;

  beforeEach(() => {
    container = makeContainer();
    editor = new ForwardsEditor(container);
  });

  it("starts with no rows and an add button", () => {
    expect(container.querySelectorAll(".forward-row")).toHaveLength(0);
    expect(container.querySelector(".forwards-add")).not.toBeNull();
  });

  it("round-trips forwards through set/get", () => {
    const forwards = [
      sampleForward({ id: "a", name: "Postgres", localPort: 5432 }),
      sampleForward({ id: "b", name: "Redis", localPort: 6379, remotePort: 6379 }),
    ];
    editor.setForwards(forwards);
    expect(container.querySelectorAll(".forward-row")).toHaveLength(2);
    expect(editor.getForwards()).toEqual(forwards);
  });

  it("preserves ids across a round trip", () => {
    const forwards = [sampleForward({ id: "keep-me" })];
    editor.setForwards(forwards);
    const back = editor.getForwards();
    expect(back[0]!.id).toBe("keep-me");
  });

  it("adds an empty row on the add button", () => {
    container.querySelector<HTMLButtonElement>(".forwards-add")!.click();
    expect(container.querySelectorAll(".forward-row")).toHaveLength(1);
    // A new row defaults its local address to loopback.
    expect(editor.getForwards()[0]!.localAddr).toBe("127.0.0.1");
  });

  it("removes a row on its remove button", () => {
    editor.setForwards([
      sampleForward({ id: "a", localPort: 5432 }),
      sampleForward({ id: "b", localPort: 6379 }),
    ]);
    container
      .querySelectorAll<HTMLButtonElement>(".forward-remove")[0]!
      .click();
    const back = editor.getForwards();
    expect(back).toHaveLength(1);
    expect(back[0]!.id).toBe("b");
  });

  it("defaults a blank local address to loopback on read", () => {
    editor.setForwards([sampleForward({ localAddr: "" })]);
    expect(editor.getForwards()[0]!.localAddr).toBe("127.0.0.1");
  });

  it("validates valid forwards as ok with no row errors", () => {
    editor.setForwards([sampleForward()]);
    expect(editor.validate()).toBe(true);
    expect(container.querySelector(".forward-row .error-text")!.textContent).toBe(
      "",
    );
  });

  it("flags an invalid forward and renders an error on its row", () => {
    editor.setForwards([sampleForward({ remoteHost: "" })]);
    expect(editor.validate()).toBe(false);
    expect(
      container.querySelector(".forward-row .error-text")!.textContent,
    ).not.toBe("");
  });

  it("flags a duplicate bind pair on the second row", () => {
    editor.setForwards([
      sampleForward({ id: "a", name: "a", localPort: 5432 }),
      sampleForward({ id: "b", name: "b", localPort: 5432 }),
    ]);
    expect(editor.validate()).toBe(false);
    const rows = container.querySelectorAll(".forward-row .error-text");
    expect(rows[1]!.textContent).not.toBe("");
  });
});
