/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Device } from "../../ipc";
import { t } from "../../i18n";
import { paneMarkup } from "./paneTemplate";
import { DeviceSelect, deviceOptionLabel } from "./deviceSelect";

function sshDevice(id: string, name: string): Device {
  return {
    id,
    name,
    kind: "ssh",
    host: `${id}.lan`,
    port: 22,
    username: "admin",
    auth: { method: "password" },
    forwards: [],
    tunnelAutoStart: false,
    proxyJump: null,
    forwardAgent: false,
    autoReconnect: false,
    tags: [],
    connectSnippet: null,
  };
}

const nas = sshDevice("d1", "NAS");
const pi = sshDevice("d2", "Pi");

describe("DeviceSelect", () => {
  let root: HTMLElement;
  let onPick: ReturnType<typeof vi.fn<(deviceId: string) => void>>;
  let picker: DeviceSelect;
  let select: HTMLSelectElement;

  beforeEach(() => {
    root = document.createElement("div");
    root.innerHTML = paneMarkup();
    onPick = vi.fn<(deviceId: string) => void>();
    picker = new DeviceSelect(root, onPick);
    select = root.querySelector<HTMLSelectElement>(".pane-device-select")!;
  });

  it("lists every device with its endpoint, selecting the assigned one", () => {
    picker.render([nas, pi], "d2");
    const options = [...select.options];
    expect(options.map((o) => o.textContent)).toEqual([deviceOptionLabel(nas), deviceOptionLabel(pi)]);
    expect(select.value).toBe("d2");
  });

  it("keeps the dropdown's own choice when nothing is assigned", () => {
    picker.render([nas, pi], null);
    select.value = "d2";
    picker.render([nas, pi], null);
    expect(select.value).toBe("d2");
  });

  it("shows a disabled placeholder when there are no devices", () => {
    picker.render([], null);
    expect(select.options).toHaveLength(1);
    expect(select.options[0]?.disabled).toBe(true);
    expect(select.options[0]?.textContent).toBe(t("pane.noDevices"));
  });

  it("reports a pick", () => {
    picker.render([nas, pi], null);
    select.value = "d2";
    select.dispatchEvent(new Event("change"));
    expect(onPick).toHaveBeenCalledWith("d2");
  });

  it("selects a device programmatically, or none", () => {
    picker.render([nas, pi], null);
    picker.select("d2");
    expect(picker.value()).toBe("d2");
    picker.select(null);
    expect(picker.value()).toBe("");
  });

  it("locks the dropdown", () => {
    picker.setLocked(true);
    expect(select.disabled).toBe(true);
    picker.setLocked(false);
    expect(select.disabled).toBe(false);
  });

  it("shows the device's endpoint as the header tooltip, or none", () => {
    const header = root.querySelector<HTMLElement>(".pane-header")!;
    picker.showEndpoint(nas);
    expect(header.title).toBe("d1.lan:22");
    picker.showEndpoint(undefined);
    expect(header.hasAttribute("title")).toBe(false);
  });
});
