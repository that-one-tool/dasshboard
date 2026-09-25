import { describe, it, expect } from "vitest";
import type { Forward } from "../ipc";
import {
  isLoopbackAddress,
  validateForwards,
  type ForwardFormValues,
} from "./forwardValidation";

function sampleForward(overrides: Partial<Forward> = {}): ForwardFormValues {
  return {
    id: "f1",
    name: "Postgres",
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

  it("does not flag the same local port on distinct loopback addresses", () => {
    const errors = validateForwards([
      sampleForward({ name: "a", localAddr: "127.0.0.1", localPort: 5432 }),
      sampleForward({ name: "b", localAddr: "::1", localPort: 5432 }),
    ]);
    expect(errors).toEqual([]);
  });
});
