/** The Tunnels card's DOM: one card per tunnelable device (status icon, Start
 * all / Stop all) with a row per forward (status dot, name over endpoint,
 * copy, Start/Stop). Clicks go to the panel through `TunnelCardActions`. */

import type { Forward, ForwardKind, SshDevice, TunnelStatus } from "../ipc";
import { t } from "../i18n";
import { copyIcon, playIcon, stopIcon, wifiIcon, wifiOffIcon } from "../ui/icons";
import {
  copyTarget,
  forwardEndpoint,
  forwardState,
  statusLabel,
  type DeviceTunnelState,
  type ForwardState,
} from "./tunnelForwards";

export interface TunnelCardActions {
  startAll(device: SshDevice): void;
  stopAll(deviceId: string): void;
  startForward(deviceId: string, forwardId: string): void;
  stopForward(deviceId: string, forwardId: string): void;
  copy(text: string): void;
}

export function makeTunnelCardShell(): string {
  return `
      <div class="tunnel-manager">
        <div class="device-list-header">
          <h2>${t("tunnels.title")}</h2>
        </div>
        <div class="tunnel-list-items"></div>
      </div>
    `;
}

/** Replaces `body`'s content; `findActiveState` gives a device's running tunnel. */
export function renderTunnelCards(
  body: HTMLElement,
  devices: SshDevice[],
  findActiveState: (deviceId: string) => DeviceTunnelState | undefined,
  actions: TunnelCardActions,
): void {
  if (devices.length === 0) {
    body.replaceChildren(makeEmptyEl());
    return;
  }
  body.replaceChildren(...devices.map((device) => makeDeviceCardEl(device, findActiveState(device.id), actions)));
}

function makeEmptyEl(): HTMLElement {
  const empty = document.createElement("p");
  empty.className = "tunnels-empty";
  empty.textContent = t("tunnels.empty");
  return empty;
}

function makeDeviceCardEl(device: SshDevice, state: DeviceTunnelState | undefined, actions: TunnelCardActions): HTMLElement {
  const card = document.createElement("div");
  card.className = "tunnel-card";
  card.dataset.deviceId = device.id;
  const header = document.createElement("div");
  header.className = "tunnel-card-header";
  const title = document.createElement("span");
  title.className = "tunnel-card-name";
  title.textContent = device.name;
  header.append(title, makeStatusIconEl(state?.status ?? "stopped"), makeAllActionEl(device, state !== undefined, actions));
  card.append(header, makeForwardListEl(device, state, actions));
  return card;
}

function makeAllActionEl(device: SshDevice, running: boolean, actions: TunnelCardActions): HTMLButtonElement {
  return running
    ? makeActionButton("btn-danger", stopIcon, t("tunnels.stopAll"), () => actions.stopAll(device.id))
    : makeActionButton("btn-primary", playIcon, t("tunnels.startAll"), () => actions.startAll(device));
}

/** Every configured forward is listed, running or not. */
function makeForwardListEl(device: SshDevice, state: DeviceTunnelState | undefined, actions: TunnelCardActions): HTMLElement {
  const list = document.createElement("ul");
  list.className = "tunnel-forwards";
  for (const forward of device.forwards) {
    list.appendChild(makeForwardRowEl(device.id, forward, forwardState(state, forward.id), actions));
  }
  return list;
}

function makeForwardRowEl(deviceId: string, forward: Forward, state: ForwardState, actions: TunnelCardActions): HTMLElement {
  const li = document.createElement("li");
  li.className = "tunnel-forward";
  li.dataset.forwardId = forward.id;
  li.classList.toggle("is-unbound", state === "unbound");
  li.append(
    makeForwardDotEl(state, forward.kind),
    makeForwardTextEl({ name: forward.name, text: forwardEndpoint(forward), warning: getUnboundWarning(state, forward.kind) }),
    makeCopyButton(forward, actions),
    makeForwardActionEl(deviceId, forward.id, state !== "stopped", actions),
  );
  return li;
}

function makeCopyButton(forward: Forward, actions: TunnelCardActions): HTMLButtonElement {
  const title = forward.kind === "remote" ? t("tunnels.copy.serverTitle") : t("tunnels.copy.title");
  return makeActionButton("btn-secondary tunnel-copy", copyIcon, title, () => actions.copy(copyTarget(forward)));
}

function makeForwardActionEl(
  deviceId: string,
  forwardId: string,
  running: boolean,
  actions: TunnelCardActions,
): HTMLButtonElement {
  return running
    ? makeActionButton("btn-danger tunnel-forward-toggle", stopIcon, t("tunnels.stop"), () =>
        actions.stopForward(deviceId, forwardId),
      )
    : makeActionButton("btn-primary tunnel-forward-toggle", playIcon, t("tunnels.start"), () =>
        actions.startForward(deviceId, forwardId),
      );
}

function getUnboundWarning(state: ForwardState, kind: ForwardKind): string | null {
  return state === "unbound" ? getUnboundLabel(kind) : null;
}

/** Why a forward isn't serving: a remote one's port is the server's to grant. */
function getUnboundLabel(kind: ForwardKind): string {
  return kind === "remote" ? t("tunnels.serverRefused") : t("tunnels.portInUse");
}

function getForwardStateLabel(state: ForwardState, kind: ForwardKind): string {
  return state === "unbound" ? getUnboundLabel(kind) : statusLabel(state);
}

/**
 * The tunnel's status as an icon: wifi while listening or connecting (colored
 * per state by CSS), crossed-out wifi otherwise. The label stays available as
 * a tooltip and to assistive tech.
 */
function makeStatusIconEl(status: TunnelStatus | "stopped"): HTMLElement {
  const active = status === "listening" || status === "connecting";
  const el = makeLabelledImgEl(`tunnel-status is-${status}`, statusLabel(status));
  el.innerHTML = active ? wifiIcon : wifiOffIcon;
  return el;
}

/** A forward's status as a colored dot (gray / yellow / green / red). */
function makeForwardDotEl(state: ForwardState, kind: ForwardKind): HTMLElement {
  return makeLabelledImgEl(`tunnel-forward-dot is-${state}`, getForwardStateLabel(state, kind));
}

function makeLabelledImgEl(className: string, label: string): HTMLElement {
  const el = document.createElement("span");
  el.className = className;
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", label);
  el.title = label;
  return el;
}

/**
 * A forward's name (plus why, when it isn't serving: port in use, or refused
 * by the server) over its `local → remote` endpoint. Both lines truncate in a
 * narrow sidebar, so each keeps its full text as a tooltip.
 */
function makeForwardTextEl(row: { name: string; text: string; warning: string | null }): HTMLElement {
  const text = document.createElement("div");
  text.className = "tunnel-forward-text";
  const label = document.createElement("div");
  label.className = "tunnel-forward-label";
  label.appendChild(makeTruncatedEl("span", "tunnel-forward-name", row.name));
  if (row.warning) label.appendChild(makeWarningEl(row.warning));
  text.append(label, makeTruncatedEl("code", "tunnel-forward-endpoint", row.text));
  return text;
}

function makeWarningEl(warning: string): HTMLElement {
  const warn = document.createElement("span");
  warn.className = "tunnel-forward-warn";
  warn.textContent = warning;
  return warn;
}

/** An element whose text may be cut off by CSS, with the full text as tooltip. */
function makeTruncatedEl(tag: string, className: string, value: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = value;
  el.title = value;
  return el;
}

/** An icon-only button; `label` becomes its tooltip and accessible name. */
function makeActionButton(variant: string, icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `btn btn-icon ${variant}`;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = icon;
  button.addEventListener("click", onClick);
  return button;
}
