/** The sidebar device list's HTML: an empty state, a flat list when nothing is
 * tagged, or collapsible sections grouped by first tag. Every device-provided
 * string is escaped. */

import type { Device } from "../../ipc";
import { t } from "../../i18n";
import { chevronUpIcon, pencilIcon, trashIcon } from "../../ui/icons";
import { deviceEndpoint } from "../deviceEndpoint";
import { deviceGroupKey, filterDevices, groupDevicesByFirstTag, type DeviceGroup } from "../deviceFilter";

export interface DeviceListState {
  searchQuery: string;
  /** Keys (`deviceGroupKey`) of the collapsed tag sections. */
  collapsed: ReadonlySet<string>;
}

export function deviceListHtml(devices: Device[], state: DeviceListState): string {
  if (devices.length === 0) return emptyStateHtml(t("devices.empty"));
  const filtered = filterDevices(devices, state.searchQuery);
  if (filtered.length === 0) return emptyStateHtml(t("devices.noMatches"));
  return groupsHtml(groupDevicesByFirstTag(filtered), state);
}

function emptyStateHtml(text: string): string {
  return `<div class="empty-state">${text}</div>`;
}

/** One untagged group renders flat (no headers). */
function groupsHtml(groups: DeviceGroup[], state: DeviceListState): string {
  return isFlat(groups)
    ? devicesHtml(groups[0]!.devices)
    : groups.map((group, index) => deviceGroupHtml(group, index, state)).join("");
}

function isFlat(groups: DeviceGroup[]): boolean {
  return groups.length === 1 && groups[0]?.tag === null;
}

function devicesHtml(devices: Device[]): string {
  return devices.map(deviceItemHtml).join("");
}

/**
 * A collapsible tag section: a header button (the tag, or "Untagged", then
 * the device count and a chevron) over its device rows. While searching every
 * section shows expanded and its toggle is disabled, so no match is hidden.
 */
function deviceGroupHtml(group: DeviceGroup, index: number, state: DeviceListState): string {
  const searching = state.searchQuery.trim() !== "";
  const expanded = searching || !state.collapsed.has(deviceGroupKey(group.tag));
  const itemsId = `device-group-items-${index}`;
  return `
      <div class="device-group">
        ${deviceGroupHeaderHtml(group, itemsId, expanded, searching)}
        <div class="device-group-items" id="${itemsId}" ${expanded ? "" : "hidden"}>
          ${devicesHtml(group.devices)}
        </div>
      </div>
    `;
}

function deviceGroupHeaderHtml(group: DeviceGroup, itemsId: string, expanded: boolean, disabled: boolean): string {
  return `
        <button
          type="button"
          class="device-group-header"
          data-group-key="${escapeHtml(deviceGroupKey(group.tag))}"
          aria-expanded="${expanded}"
          aria-controls="${itemsId}"
          ${disabled ? "disabled" : ""}
        >
          ${deviceGroupLabelHtml(group)}
        </button>
    `;
}

function deviceGroupLabelHtml(group: DeviceGroup): string {
  return `<span class="device-group-label">${escapeHtml(groupLabel(group.tag))}</span>
          <span class="device-group-count">(${group.devices.length})</span>
          <span class="device-group-chevron">${chevronUpIcon}</span>`;
}

/** A tag section's header label: the tag, or "Untagged". */
function groupLabel(tag: string | null): string {
  return tag ?? t("devices.group.untagged");
}

/** One device tile: name + edit/delete actions, then the endpoint. */
function deviceItemHtml(device: Device): string {
  return `
      <div class="device-item">
        <div class="device-row">
          <div class="device-name">${escapeHtml(device.name)}</div>
          <div class="device-actions">
          ${deviceButtonHtml("btn-edit", device.id, t("devices.edit.aria"), pencilIcon)}
          ${deviceButtonHtml("btn-danger btn-delete", device.id, t("devices.delete.aria"), trashIcon)}
          </div>
        </div>
        <div class="device-row">
          <div class="device-host">${escapeHtml(deviceEndpoint(device))}</div>
        </div>
      </div>
    `;
}

function deviceButtonHtml(className: string, deviceId: string, label: string, icon: string): string {
  return `
          <button
            class="btn btn-icon ${className}"
            data-device-id="${escapeHtml(deviceId)}"
            title="${label}"
            aria-label="${label}"
          >
            ${icon}
          </button>`;
}

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for element content and quoted attribute values alike. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char] ?? char);
}
