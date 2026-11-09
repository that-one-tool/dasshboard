/** The agent-identity `<select>` of the device dialog. */

import { t } from "../../i18n";
import type { AgentIdentityInfo } from "../../ipc";
import { createOption } from "../../ui/dom";

/** Populate the agent-identity `<select>` from a live agent listing, preserving
 * the currently-selected fingerprint (e.g. a saved device's). A previously
 * selected fingerprint the agent no longer lists is kept as a marked option so
 * the saved value is not silently lost. */
export function populateAgentIdentities(
  root: ParentNode,
  identities: AgentIdentityInfo[],
  selectedFingerprint?: string,
): void {
  const select = root.querySelector<HTMLSelectElement>("#device-agent-identity");
  if (!select) return;
  const previous = selectedFingerprint ?? select.value;
  select.replaceChildren(...identities.map(identityOption));
  keepSelected(select, previous);
}

/** Empties the agent-identity picker and its status line, so one device's
 * identity is never offered (preselected) for the next one opened. */
export function clearAgentIdentities(root: ParentNode): void {
  const select = root.querySelector<HTMLSelectElement>("#device-agent-identity");
  const status = root.querySelector<HTMLElement>("#device-agent-status");
  if (select) select.innerHTML = "";
  if (status) status.textContent = "";
}

function identityOption(identity: AgentIdentityInfo): HTMLOptionElement {
  const label = [identity.comment || identity.algorithm, identity.fingerprint].filter(Boolean).join(" — ");
  return createOption(identity.fingerprint, identity.isSecurityKey ? `🔑 ${label}` : label);
}

/** Selects `previous`, adding it as "not in the agent" when it isn't listed. */
function keepSelected(select: HTMLSelectElement, previous: string): void {
  if (!previous) return;
  if (!hasOption(select, previous)) select.appendChild(createOption(previous, `${previous} ${t("devices.agent.notPresent")}`));
  select.value = previous;
}

function hasOption(select: HTMLSelectElement, value: string): boolean {
  return Array.from(select.options).some((option) => option.value === value);
}
