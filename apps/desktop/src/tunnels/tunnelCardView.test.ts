/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Forward, SshDevice } from "../ipc";
import { t } from "../i18n";
import { wifiIcon, wifiOffIcon } from "../ui/icons";
import type { DeviceTunnelState } from "./tunnelForwards";
import { renderTunnelCards, makeTunnelCardShell, type TunnelCardActions } from "./tunnelCardView";

function forward(id: string, kind: Forward["kind"] = "local"): Forward {
  return { id, name: `fwd-${id}`, kind, localAddr: "127.0.0.1", localPort: 5432, remoteHost: "db", remotePort: 6543 };
}

const nas = { id: "d1", name: "NAS", kind: "ssh", forwards: [forward("f1"), forward("f2", "remote")] } as SshDevice;

function running(requested: string[], bound: Record<string, boolean> = {}): DeviceTunnelState {
  return {
    tunnelId: "t1",
    status: "listening",
    requested: new Set(requested),
    forwards: Object.entries(bound).map(([forwardId, isBound]) => ({
      forwardId,
      localAddr: "127.0.0.1",
      localPort: 5432,
      remoteHost: "db",
      remotePort: 6543,
      bound: isBound,
    })),
  };
}

describe("tunnelCardView", () => {
  let body: HTMLElement;
  let actions: { [K in keyof TunnelCardActions]: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    body = document.createElement("div");
    actions = {
      startAll: vi.fn(),
      stopAll: vi.fn(),
      startForward: vi.fn(),
      stopForward: vi.fn(),
      copy: vi.fn(),
    };
  });

  const render = (state?: DeviceTunnelState): void =>
    renderTunnelCards(body, [nas], () => state, actions as TunnelCardActions);
  const click = (selector: string): void => body.querySelector<HTMLElement>(selector)!.click();
  const dot = (forwardId: string): string | undefined =>
    body.querySelector(`[data-forward-id="${forwardId}"] .tunnel-forward-dot`)?.className;

  it("has a list body in its shell", () => {
    const shell = document.createElement("div");
    shell.innerHTML = makeTunnelCardShell();
    expect(shell.querySelector(".tunnel-list-items")).not.toBeNull();
    expect(shell.textContent).toContain(t("tunnels.title"));
  });

  it("says so when no device has forwards", () => {
    renderTunnelCards(body, [], () => undefined, actions as TunnelCardActions);
    expect(body.querySelector(".tunnels-empty")?.textContent).toBe(t("tunnels.empty"));
  });

  it("renders one card per device with a row per forward, replacing what was there", () => {
    render();
    render();
    expect(body.querySelectorAll(".tunnel-card")).toHaveLength(1);
    expect(body.querySelector<HTMLElement>(".tunnel-card")?.dataset.deviceId).toBe("d1");
    expect(body.querySelector(".tunnel-card-name")?.textContent).toBe("NAS");
    expect(body.querySelectorAll(".tunnel-forward")).toHaveLength(2);
  });

  it("a stopped device offers Start all and shows stopped dots", () => {
    render();
    expect(body.querySelector(".tunnel-status")?.getAttribute("aria-label")).toBe(t("tunnels.status.stopped"));
    expect(dot("f1")).toContain("is-stopped");
    expect(body.querySelector(".tunnel-card-header .btn-primary")?.classList.contains("tunnel-forward-toggle")).toBe(false);
    click(".tunnel-card-header .btn-primary");
    expect(actions.startAll).toHaveBeenCalledWith(nas);
  });

  it("a running device offers Stop all and shows each forward's state", () => {
    render(running(["f1", "f2"], { f1: true }));
    expect(body.querySelector(".tunnel-status")?.classList.contains("is-listening")).toBe(true);
    expect(dot("f1")).toContain("is-listening");
    expect(dot("f2")).toContain("is-connecting");
    click(".tunnel-card-header .btn-danger");
    expect(actions.stopAll).toHaveBeenCalledWith("d1");
  });

  it("starts or stops one forward from its own toggle", () => {
    render(running(["f1"], { f1: true }));
    click('[data-forward-id="f1"] .tunnel-forward-toggle');
    click('[data-forward-id="f2"] .tunnel-forward-toggle');
    expect(actions.stopForward).toHaveBeenCalledWith("d1", "f1");
    expect(actions.startForward).toHaveBeenCalledWith("d1", "f2");
  });

  it("explains an unbound forward: port in use, or refused by the server", () => {
    render(running(["f1", "f2"], { f1: false, f2: false }));
    const warning = (id: string) => body.querySelector(`[data-forward-id="${id}"] .tunnel-forward-warn`)?.textContent;
    expect(warning("f1")).toBe(t("tunnels.portInUse"));
    expect(warning("f2")).toBe(t("tunnels.serverRefused"));
    expect(body.querySelector('[data-forward-id="f1"]')?.classList.contains("is-unbound")).toBe(true);
  });

  it("a serving forward has no warning", () => {
    render(running(["f1"], { f1: true }));
    const row = body.querySelector('[data-forward-id="f1"]');
    expect(row?.classList.contains("is-unbound")).toBe(false);
    expect(row?.querySelector(".tunnel-forward-warn")).toBeNull();
  });

  it("shows the wifi icon while active and the crossed-out one when stopped", () => {
    const iconOf = (): string | undefined => body.querySelector(".tunnel-status")?.innerHTML;
    const parsed = (icon: string): string => Object.assign(document.createElement("span"), { innerHTML: icon }).innerHTML;
    render();
    expect(iconOf()).toBe(parsed(wifiOffIcon));
    render(running(["f1"]));
    expect(iconOf()).toBe(parsed(wifiIcon));
    render({ ...running(["f1"]), status: "connecting" });
    expect(iconOf()).toBe(parsed(wifiIcon));
  });

  it("copies the address a client connects to", () => {
    render();
    click('[data-forward-id="f1"] .tunnel-copy');
    click('[data-forward-id="f2"] .tunnel-copy');
    expect(actions.copy.mock.calls).toEqual([["127.0.0.1:5432"], ["db:6543"]]);
    expect(body.querySelector<HTMLElement>('[data-forward-id="f2"] .tunnel-copy')?.title).toBe(
      t("tunnels.copy.serverTitle"),
    );
  });
});
