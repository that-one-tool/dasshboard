/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect } from "vitest";
import type { Device } from "../../ipc";
import { deviceListHtml, type DeviceListState } from "./deviceListMarkup";

function sshDevice(id: string, name: string, tags: string[] = []): Device {
  return {
    id, name, kind: "ssh", host: `${id}.lan`, port: 22, username: "me",
    auth: { method: "password" }, forwards: [], tunnelAutoStart: false, proxyJump: null,
    forwardAgent: false, x11Forwarding: "off", autoReconnect: false, tags, connectSnippet: null,
  };
}

const idle: DeviceListState = { searchQuery: "", collapsed: new Set() };

function render(devices: Device[], state: DeviceListState = idle): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = deviceListHtml(devices, state);
  return root;
}

describe("deviceListHtml", () => {
  it("shows the empty state when there are no devices", () => {
    expect(render([]).querySelector(".empty-state")?.textContent).toContain("No hosts/devices yet");
  });

  it("shows the no-matches state when the search filters everything out", () => {
    const root = render([sshDevice("a", "Alpha")], { searchQuery: "zzz", collapsed: new Set() });
    expect(root.querySelector(".empty-state")?.textContent).toBe("No devices match your search.");
  });

  it("renders a flat list without headers when nothing is tagged", () => {
    const root = render([sshDevice("a", "Alpha"), sshDevice("b", "Bravo")]);
    expect(root.querySelectorAll(".device-group")).toHaveLength(0);
    expect([...root.querySelectorAll(".device-name")].map((el) => el.textContent)).toEqual(["Alpha", "Bravo"]);
    expect(root.querySelector(".device-host")?.textContent).toBe("a.lan:22");
  });

  it("renders edit and delete buttons carrying the device id", () => {
    const root = render([sshDevice("a", "Alpha")]);
    expect(root.querySelector<HTMLElement>(".btn-edit")?.dataset.deviceId).toBe("a");
    expect(root.querySelector<HTMLElement>(".btn-danger.btn-delete")?.dataset.deviceId).toBe("a");
    expect(root.querySelector(".btn-edit")?.getAttribute("aria-label")).toBeTruthy();
  });

  it("groups by first tag with counts, untagged last, and hides collapsed sections", () => {
    const devices = [sshDevice("a", "Alpha", ["web"]), sshDevice("b", "Bravo")];
    const root = render(devices, { searchQuery: "", collapsed: new Set(["web"]) });
    const headers = [...root.querySelectorAll<HTMLButtonElement>(".device-group-header")];
    expect(headers.map((h) => h.querySelector(".device-group-label")?.textContent)).toEqual(["web", "Untagged"]);
    expect(headers[0]?.querySelector(".device-group-count")?.textContent).toBe("(1)");
    expect(headers[0]?.getAttribute("aria-expanded")).toBe("false");
    expect(root.querySelector<HTMLElement>("#device-group-items-0")?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>("#device-group-items-1")?.hidden).toBe(false);
  });

  it("expands every section and disables the toggles while searching", () => {
    const devices = [sshDevice("a", "Alpha", ["web"]), sshDevice("b", "Bravo", ["db"])];
    const root = render(devices, { searchQuery: "a", collapsed: new Set(["web"]) });
    const header = root.querySelector<HTMLButtonElement>(".device-group-header");
    expect(header?.disabled).toBe(true);
    expect(header?.getAttribute("aria-expanded")).toBe("true");
  });

  it("escapes device text in content and attributes", () => {
    const root = render([sshDevice('x" data-evil="1', "<b>Bold</b> & 'co'")]);
    expect(root.querySelector(".device-name")?.textContent).toBe("<b>Bold</b> & 'co'");
    expect(root.querySelector(".device-name b")).toBeNull();
    expect(root.querySelector("[data-evil]")).toBeNull();
  });
});
