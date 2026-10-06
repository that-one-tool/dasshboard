import { afterEach, describe, it, expect } from "vitest";
import { fr } from "../i18n/fr";
import { setLocale } from "../i18n";
import type { Forward } from "../ipc";
import {
  isLoopbackAddress,
  validateForwards,
  type ForwardFormValues,
} from "./forwardValidation";

afterEach(() => setLocale("en"));

function sampleForward(overrides: Partial<Forward> = {}): ForwardFormValues {
  return {
    id: "f1",
    name: "Postgres",
    kind: "local",
    localAddr: "127.0.0.1",
    localPort: 5432,
    remoteHost: "127.0.0.1",
    remotePort: 5432,
    ...overrides,
  };
}

describe("isLoopbackAddress", () => {
  it("accepts IPv4 loopback range and IPv6 ::1", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.5.6.7")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
  });

  it("rejects non-loopback and malformed addresses", () => {
    expect(isLoopbackAddress("0.0.0.0")).toBe(false);
    expect(isLoopbackAddress("192.168.1.1")).toBe(false);
    expect(isLoopbackAddress("999.0.0.1")).toBe(false);
    expect(isLoopbackAddress("not-an-ip")).toBe(false);
  });
});

describe("validateForwards", () => {
  it("accepts an empty list", () => {
    expect(validateForwards([])).toEqual([]);
  });

  it("accepts distinct valid forwards", () => {
    const errors = validateForwards([
      sampleForward({ name: "Postgres", localPort: 5432 }),
      sampleForward({ name: "Redis", localPort: 6379 }),
    ]);
    expect(errors).toEqual([]);
  });

  it("treats a blank local address as the loopback default", () => {
    const errors = validateForwards([sampleForward({ localAddr: "" })]);
    expect(errors).toEqual([]);
  });

  it("flags an empty name", () => {
    const errors = validateForwards([sampleForward({ name: "  " })]);
    expect(errors.some((e) => e.field === "forward-0-name")).toBe(true);
  });

  it("flags an empty remote host", () => {
    const errors = validateForwards([sampleForward({ remoteHost: "" })]);
    expect(errors.some((e) => e.field === "forward-0-remoteHost")).toBe(true);
  });

  it("flags out-of-range and non-integer ports", () => {
    const errors = validateForwards([
      sampleForward({ localPort: 0, remotePort: 70000 }),
    ]);
    expect(errors.some((e) => e.field === "forward-0-localPort")).toBe(true);
    expect(errors.some((e) => e.field === "forward-0-remotePort")).toBe(true);
  });

  it("flags a non-loopback local address", () => {
    const errors = validateForwards([sampleForward({ localAddr: "0.0.0.0" })]);
    expect(errors.some((e) => e.field === "forward-0-localAddr")).toBe(true);
  });

  it("flags two forwards sharing a bind pair", () => {
    const errors = validateForwards([
      sampleForward({ name: "a", localPort: 5432 }),
      sampleForward({ name: "b", localPort: 5432 }),
    ]);
    expect(errors.some((e) => e.field === "forward-1-localPort")).toBe(true);
  });

  it("accepts a dynamic forward without a destination", () => {
    const errors = validateForwards([
      sampleForward({ kind: "dynamic", remoteHost: "", remotePort: 0 }),
    ]);
    expect(errors).toEqual([]);
  });

  it("still checks a dynamic forward's local port and address", () => {
    const errors = validateForwards([
      sampleForward({ kind: "dynamic", localAddr: "0.0.0.0", localPort: 0 }),
    ]);
    expect(errors.some((e) => e.field === "forward-0-localPort")).toBe(true);
    expect(errors.some((e) => e.field === "forward-0-localAddr")).toBe(true);
  });

  it("does not flag the same local port on distinct loopback addresses", () => {
    const errors = validateForwards([
      sampleForward({ name: "a", localAddr: "127.0.0.1", localPort: 5432 }),
      sampleForward({ name: "b", localAddr: "::1", localPort: 5432 }),
    ]);
    expect(errors).toEqual([]);
  });

  it("accepts a remote forward to any local host", () => {
    const remote = sampleForward({
      kind: "remote",
      localAddr: "printer.lan",
      localPort: 631,
      remoteHost: "0.0.0.0",
      remotePort: 8631,
    });
    expect(validateForwards([remote])).toEqual([]);
  });

  it("requires a remote forward's server address and ports", () => {
    const remote = sampleForward({ kind: "remote", remoteHost: "", remotePort: 0, localPort: 0 });
    const fields = validateForwards([remote]).map((e) => e.field);
    expect(fields).toEqual(
      expect.arrayContaining(["forward-0-remoteHost", "forward-0-remotePort", "forward-0-localPort"]),
    );
  });

  it("never treats a remote forward's local target as a bind", () => {
    const local = sampleForward({ localPort: 3000 });
    const remote = sampleForward({ id: "f2", kind: "remote", localPort: 3000, remotePort: 8080 });
    expect(validateForwards([local, remote])).toEqual([]);
  });

  it("flags two local forwards on the same address and port, translated", () => {
    setLocale("fr");
    const errors = validateForwards([sampleForward(), sampleForward({ id: "f2", name: "Copy" })]);
    expect(errors).toEqual([{ field: "forward-1-localPort", message: fr["validation.bindTaken"] }]);
  });

  it("flags a forward of a kind this version doesn't know", () => {
    const errors = validateForwards([sampleForward({ kind: "unsupported" })]);
    expect(errors.map((e) => e.field)).toEqual(["forward-0-kind"]);
  });

  it("flags two remote forwards on the same server port", () => {
    const first = sampleForward({ kind: "remote", remoteHost: "localhost", remotePort: 8080 });
    const second = { ...first, id: "f2", remoteHost: "0.0.0.0", localPort: 4000 };
    expect(validateForwards([first, second]).map((e) => e.field)).toEqual(["forward-1-remotePort"]);
  });
});
