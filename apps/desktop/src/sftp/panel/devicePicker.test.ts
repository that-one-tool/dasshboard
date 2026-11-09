/** @vitest-environment happy-dom */
import { describe, it, expect } from "vitest";
import type { Device } from "../../ipc";
import { DevicePicker, browsableDevices } from "./devicePicker";
import { buildPanelElements } from "./panelElements";
import { PanelSession } from "./panelSession";

const ssh = (id: string, name: string) => ({ id, name, kind: "ssh" }) as unknown as Device;
const serial = (id: string) => ({ id, name: id, kind: "serial" }) as unknown as Device;

function setup() {
  const els = buildPanelElements(document.createElement("aside"));
  const session = new PanelSession();
  const picker = new DevicePicker(() => els, session);
  return { els, session, picker };
}

function optionValues(select: HTMLSelectElement): string[] {
  return [...select.options].map((o) => o.value);
}

describe("browsableDevices", () => {
  it("keeps only SSH devices", () => {
    expect(browsableDevices([ssh("a", "A"), serial("s")]).map((d) => d.id)).toEqual(["a"]);
  });
});

describe("DevicePicker", () => {
  it("lists a placeholder then the SSH devices", () => {
    const { els, picker } = setup();
    picker.setDevices([ssh("a", "Alpha"), serial("s"), ssh("b", "Beta")]);
    expect(optionValues(els.deviceSelect)).toEqual(["", "a", "b"]);
    expect(els.deviceSelect.options[1]?.textContent).toBe("Alpha");
    expect(els.deviceSelect.value).toBe("");
  });

  it("points at the connected device, else the picked one", () => {
    const { els, session, picker } = setup();
    picker.setDevices([ssh("a", "Alpha"), ssh("b", "Beta")]);
    session.pickDevice("b");
    picker.sync();
    expect(els.deviceSelect.value).toBe("b");
    session.markConnected("a");
    picker.sync();
    expect(els.deviceSelect.value).toBe("a");
  });

  it("keeps the selection across a re-render", () => {
    const { els, session, picker } = setup();
    session.pickDevice("b");
    picker.setDevices([ssh("a", "Alpha"), ssh("b", "Beta")]);
    picker.render();
    expect(els.deviceSelect.value).toBe("b");
  });

  it("knows saved devices of any kind, but only browsable ones for a restore", () => {
    const { picker } = setup();
    picker.setDevices([ssh("a", "Alpha"), serial("s")]);
    expect(picker.hasDevice("s")).toBe(true);
    expect(picker.hasDevice("gone")).toBe(false);
    expect(picker.knownBrowsable("a")).toBe("a");
    expect(picker.knownBrowsable("s")).toBeNull();
    expect(picker.knownBrowsable(null)).toBeNull();
  });
});
