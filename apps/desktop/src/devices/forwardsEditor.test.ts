/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { Forward, ForwardKind } from "../ipc";
import { ForwardsEditor } from "./forwardsEditor";

function makeContainer(): HTMLElement {
  document.body.innerHTML = '<div id="host"></div>';
  return document.querySelector<HTMLElement>("#host")!;
}

function sampleForward(overrides: Partial<Forward> = {}): Forward {
  return {
    id: "f1",
    name: "Postgres",
    kind: "local",
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

  /** Pick a type in the first row's dropdown, as the user would. */
  function selectKind(kind: ForwardKind): void {
    const select = container.querySelector<HTMLSelectElement>(".forward-kind")!;
    select.value = kind;
    select.dispatchEvent(new Event("change"));
  }

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

  it("round-trips a dynamic forward without a destination", () => {
    const forwards = [
      sampleForward({ kind: "dynamic", localPort: 1080, remoteHost: "", remotePort: 0 }),
    ];
    editor.setForwards(forwards);
    expect(editor.getForwards()).toEqual(forwards);
  });

  it("drops a stale destination when a row is switched to dynamic", () => {
    editor.setForwards([sampleForward()]);
    selectKind("dynamic");
    expect(editor.getForwards()[0]).toMatchObject({
      kind: "dynamic",
      remoteHost: "",
      remotePort: 0,
    });
  });

  it("hides the destination fields of a dynamic row", () => {
    editor.setForwards([sampleForward()]);
    const row = container.querySelector<HTMLElement>(".forward-row")!;
    const destination = [".forward-arrow", ".forward-remote-host", ".forward-remote-port"];
    const hidden = () =>
      destination.map((s) => row.querySelector<HTMLElement>(s)!.hidden);
    const hint = row.querySelector<HTMLElement>(".forward-socks-hint")!;
    expect(hidden()).toEqual([false, false, false]);
    expect(hint.hidden).toBe(true);
    selectKind("dynamic");
    expect(hidden()).toEqual([true, true, true]);
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain("SOCKS proxy");
    selectKind("local");
    expect(hidden()).toEqual([false, false, false]);
    expect(hint.hidden).toBe(true);
  });

  it("leaves the remote port empty when a saved dynamic row is switched to local", () => {
    editor.setForwards([
      sampleForward({ kind: "dynamic", remoteHost: "", remotePort: 0 }),
    ]);
    selectKind("local");
    const port = container.querySelector<HTMLInputElement>(".forward-remote-port")!;
    expect(port.value).toBe("");
  });

  it("starts a new row as a local forward", () => {
    container.querySelector<HTMLButtonElement>(".forwards-add")!.click();
    expect(editor.getForwards()[0]!.kind).toBe("local");
  });

  it("validates a dynamic row without a destination as ok", () => {
    editor.setForwards([sampleForward({ remoteHost: "" })]);
    selectKind("dynamic");
    expect(editor.validate()).toBe(true);
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

  it("puts the name with the remove button on its own line above the endpoints", () => {
    editor.setForwards([sampleForward()]);
    const row = container.querySelector(".forward-row")!;
    const nameLine = row.querySelector(":scope > .forward-name-line")!;
    const endpoints = row.querySelector(":scope > .forward-endpoints")!;
    expect(nameLine.querySelector(".forward-name")).not.toBeNull();
    expect(nameLine.querySelector(".forward-remove")).not.toBeNull();
    expect(endpoints.querySelector(".forward-kind")).not.toBeNull();
    expect(endpoints.querySelector(".forward-local-addr")).not.toBeNull();
    expect(endpoints.querySelector(".forward-remote-port")).not.toBeNull();
    expect(nameLine.compareDocumentPosition(endpoints)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("gives every input its placeholder as a tooltip (it may be cut off)", () => {
    editor.setForwards([sampleForward()]);
    const inputs = container.querySelectorAll<HTMLInputElement>(".forward-row input");
    expect(inputs).toHaveLength(5);
    for (const input of inputs) {
      expect(input.title).not.toBe("");
      expect(input.title).toBe(input.placeholder);
    }
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
