/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Device } from "../../ipc";
import { DeviceList, type DeviceListHandlers } from "./deviceList";

function sshDevice(id: string, name: string, tags: string[] = []): Device {
  return {
    id, name, kind: "ssh", host: `${id}.lan`, port: 22, username: "me",
    auth: { method: "password" }, forwards: [], tunnelAutoStart: false, proxyJump: null,
    forwardAgent: false, x11Forwarding: "off", autoReconnect: false, tags, connectSnippet: null,
  };
}

let container: HTMLElement;
let handlers: DeviceListHandlers;

beforeEach(() => {
  document.body.innerHTML = `<div><input class="device-search" /><div class="device-list-items"></div></div>`;
  container = document.body.firstElementChild as HTMLElement;
  handlers = { onEdit: vi.fn(), onDelete: vi.fn(), onPersist: vi.fn() };
});

function names(): (string | null)[] {
  return [...container.querySelectorAll(".device-name")].map((el) => el.textContent);
}

describe("DeviceList", () => {
  it("renders, finds and lists the shown devices", () => {
    const list = new DeviceList(container, handlers);
    const devices = [sshDevice("a", "Alpha"), sshDevice("b", "Bravo")];
    list.show(devices);
    expect(names()).toEqual(["Alpha", "Bravo"]);
    expect(list.all()).toBe(devices);
    expect(list.find("b")?.name).toBe("Bravo");
    expect(list.find("zzz")).toBeUndefined();
  });

  it("routes edit and delete clicks with the device id", () => {
    const list = new DeviceList(container, handlers);
    list.show([sshDevice("a", "Alpha")]);
    container.querySelector<HTMLButtonElement>(".btn-edit")?.click();
    container.querySelector<HTMLButtonElement>(".btn-delete")?.click();
    expect(handlers.onEdit).toHaveBeenCalledWith("a");
    expect(handlers.onDelete).toHaveBeenCalledWith("a");
  });

  it("filters live from the search box and keeps the query across a rebuild", () => {
    const list = new DeviceList(container, handlers);
    list.wireSearch();
    list.show([sshDevice("a", "Alpha"), sshDevice("b", "Bravo")]);
    const search = container.querySelector<HTMLInputElement>(".device-search")!;
    search.value = "brav";
    search.dispatchEvent(new Event("input"));
    expect(names()).toEqual(["Bravo"]);
    container.innerHTML = `<input class="device-search" /><div class="device-list-items"></div>`;
    list.wireSearch();
    expect(container.querySelector<HTMLInputElement>(".device-search")?.value).toBe("brav");
  });

  it("collapses and expands a section, asking for a save each time", () => {
    const list = new DeviceList(container, handlers);
    list.show([sshDevice("a", "Alpha", ["Web"]), sshDevice("b", "Bravo")]);
    const header = container.querySelector<HTMLButtonElement>(".device-group-header")!;
    header.click();
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector<HTMLElement>("#device-group-items-0")?.hidden).toBe(true);
    expect(list.collapsedGroups()).toEqual(["web"]);
    header.click();
    expect(list.collapsedGroups()).toBeUndefined();
    expect(handlers.onPersist).toHaveBeenCalledTimes(2);
  });

  it("starts with the given sections collapsed, lower-cased and sorted", () => {
    const list = new DeviceList(container, handlers, ["Web", "db"]);
    expect(list.collapsedGroups()).toEqual(["db", "web"]);
  });

  it("does nothing without a list element", () => {
    container.innerHTML = "";
    const list = new DeviceList(container, handlers);
    expect(() => list.show([sshDevice("a", "Alpha")])).not.toThrow();
  });
});
