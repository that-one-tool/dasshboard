import { describe, it, expect } from "vitest";
import type { Device } from "../ipc";
import {
  parseTags,
  deviceMatchesQuery,
  filterDevices,
  groupDevicesByFirstTag,
} from "./deviceFilter";

function ssh(name: string, host: string, tags: string[] = []): Device {
  return {
    id: `id-${name}`,
    name,
    kind: "ssh",
    host,
    port: 22,
    username: "u",
    auth: { method: "password" },
    forwards: [],
    tunnelAutoStart: false,
    proxyJump: null,
    forwardAgent: false,
    autoReconnect: false,
    tags,
    connectSnippet: null,
  };
}

function serial(name: string, portName: string, tags: string[] = []): Device {
  return {
    id: `id-${name}`,
    name,
    kind: "serial",
    portName,
    baudRate: 115200,
    dataBits: 8,
    parity: "none",
    stopBits: 1,
    flowControl: "none",
    autoReconnect: false,
    tags,
    connectSnippet: null,
  };
}

describe("parseTags", () => {
  it("trims, drops empties, and dedupes case-insensitively (keeping first casing + order)", () => {
    expect(parseTags("prod, Prod ,  , web")).toEqual(["prod", "web"]);
    expect(parseTags("")).toEqual([]);
    expect(parseTags("   ")).toEqual([]);
    // Newlines are also accepted as separators.
    expect(parseTags("a\nb, a")).toEqual(["a", "b"]);
  });
});

describe("deviceMatchesQuery", () => {
  const dev = ssh("Prod DB", "10.0.0.5", ["database", "prod"]);

  it("matches on name, endpoint, and tags, case-insensitively", () => {
    expect(deviceMatchesQuery(dev, "prod db")).toBe(true); // name
    expect(deviceMatchesQuery(dev, "10.0.0")).toBe(true); // host:port endpoint
    expect(deviceMatchesQuery(dev, "DATABASE")).toBe(true); // tag
    expect(deviceMatchesQuery(dev, "nope")).toBe(false);
  });

  it("matches a serial device on its endpoint (portName @ baud)", () => {
    expect(deviceMatchesQuery(serial("Ard", "COM3"), "com3")).toBe(true);
  });

  it("an empty/whitespace query matches everything", () => {
    expect(deviceMatchesQuery(dev, "")).toBe(true);
    expect(deviceMatchesQuery(dev, "   ")).toBe(true);
  });
});

describe("filterDevices", () => {
  it("keeps only matching devices in input order", () => {
    const list = [ssh("Alpha", "h1", ["x"]), ssh("Beta", "h2", ["y"]), ssh("Gamma", "h3")];
    expect(filterDevices(list, "y").map((d) => d.name)).toEqual(["Beta"]);
    expect(filterDevices(list, "").map((d) => d.name)).toEqual(["Alpha", "Beta", "Gamma"]);
  });
});

describe("groupDevicesByFirstTag", () => {
  it("groups by first tag, sorts tagged groups alpha, untagged last", () => {
    const list = [
      ssh("A", "h", ["web"]),
      ssh("B", "h", ["db", "web"]),
      ssh("C", "h"),
      ssh("D", "h", ["web"]),
    ];
    const groups = groupDevicesByFirstTag(list);
    expect(groups.map((g) => g.tag)).toEqual(["db", "web", null]);
    // Devices keep their order within a group.
    expect(groups[1]!.devices.map((d) => d.name)).toEqual(["A", "D"]);
    expect(groups[2]!.devices.map((d) => d.name)).toEqual(["C"]);
  });

  it("buckets first tags case-insensitively, keeping first-seen casing as the label", () => {
    const groups = groupDevicesByFirstTag([
      ssh("A", "h", ["Prod"]),
      ssh("B", "h", ["prod"]),
      ssh("C", "h", ["PROD"]),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.tag).toBe("Prod");
    expect(groups[0]!.devices.map((d) => d.name)).toEqual(["A", "B", "C"]);
  });

  it("returns a single untagged group when nothing is tagged", () => {
    const groups = groupDevicesByFirstTag([ssh("A", "h"), ssh("B", "h")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.tag).toBeNull();
  });

  it("returns no groups for an empty list", () => {
    expect(groupDevicesByFirstTag([])).toEqual([]);
  });
});
