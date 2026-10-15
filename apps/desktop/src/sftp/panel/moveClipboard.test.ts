import { describe, it, expect } from "vitest";
import { t } from "../../i18n";
import { MoveClipboard, planMoves } from "./moveClipboard";

const source = { deviceId: "a", dir: "/home/j", names: ["x", "y"] };

describe("MoveClipboard", () => {
  it("holds nothing until a cut", () => {
    const clipboard = new MoveClipboard();
    expect(clipboard.pending()).toBeNull();
    expect(clipboard.canPasteInto("a", "/tmp")).toBe(false);
  });

  it("pastes only on the same connection, into another directory", () => {
    const clipboard = new MoveClipboard();
    clipboard.cut(source);
    expect(clipboard.canPasteInto("a", "/tmp")).toBe(true);
    expect(clipboard.canPasteInto("a", "/home/j")).toBe(false);
    expect(clipboard.canPasteInto("b", "/tmp")).toBe(false);
    expect(clipboard.canPasteInto(null, "/tmp")).toBe(false);
  });

  it("forgets the cut on clear", () => {
    const clipboard = new MoveClipboard();
    clipboard.cut(source);
    clipboard.clear();
    expect(clipboard.pending()).toBeNull();
  });
});

describe("planMoves", () => {
  it("moves each name into the destination", () => {
    expect(planMoves(source, "/tmp", new Set())).toEqual([
      { from: "/home/j/x", to: "/tmp/x" },
      { from: "/home/j/y", to: "/tmp/y" },
    ]);
  });

  it("refuses moving a folder into itself or below it", () => {
    const steps = planMoves({ ...source, names: ["x"] }, "/home/j/x/sub", new Set());
    expect(steps).toEqual([{ error: { code: "Validation", message: t("sftp.move.intoSelf") } }]);
    expect(planMoves({ ...source, names: ["x"] }, "/home/j/x", new Set())[0]).toHaveProperty("error");
  });

  it("does not take a sibling sharing the name's prefix for a descendant", () => {
    expect(planMoves({ ...source, names: ["x"] }, "/home/j/xy", new Set())).toEqual([
      { from: "/home/j/x", to: "/home/j/xy/x" },
    ]);
  });

  it("refuses a name the destination already has, keeping the order", () => {
    const steps = planMoves(source, "/tmp", new Set(["x"]));
    expect(steps).toEqual([
      { error: { code: "Validation", message: t("sftp.move.exists") } },
      { from: "/home/j/y", to: "/tmp/y" },
    ]);
  });
});
