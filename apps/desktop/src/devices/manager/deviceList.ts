/** The sidebar device list: holds the loaded devices, the live search and the
 * collapsed tag sections, renders into `.device-list-items` and routes each
 * row's edit/delete clicks. */

import type { Device } from "../../ipc";
import { listen } from "../../ui/dom";
import { deviceListHtml } from "./deviceListMarkup";

export interface DeviceListHandlers {
  onEdit(deviceId: string): void;
  onDelete(deviceId: string): void;
  /** A section was collapsed/expanded: the workspace should be saved. */
  onPersist(): void;
}

export class DeviceList {
  private devices: Device[] = [];
  private searchQuery = "";
  private readonly collapsedKeys: Set<string>;

  constructor(
    private readonly container: HTMLElement,
    private readonly handlers: DeviceListHandlers,
    initialCollapsed: string[] = [],
  ) {
    this.collapsedKeys = new Set(initialCollapsed.map((key) => key.toLowerCase()));
  }

  all(): Device[] {
    return this.devices;
  }

  find(deviceId: string): Device | undefined {
    return this.devices.find((device) => device.id === deviceId);
  }

  show(devices: Device[]): void {
    this.devices = devices;
    this.render();
  }

  /** The collapsed tag sections to persist (undefined when none are). */
  collapsedGroups(): string[] | undefined {
    if (this.collapsedKeys.size === 0) return undefined;
    return [...this.collapsedKeys].sort();
  }

  /** Wire the search box of freshly built markup, restoring the query a
   * language re-render blanked. */
  wireSearch(): void {
    const search = this.container.querySelector<HTMLInputElement>(".device-search");
    if (search) search.value = this.searchQuery;
    listen(this.container, ".device-search", "input", (e) => {
      this.searchQuery = (e.target as HTMLInputElement).value;
      this.render();
    });
  }

  private render(): void {
    const items = this.container.querySelector(".device-list-items");
    if (!items) return;
    items.innerHTML = deviceListHtml(this.devices, { searchQuery: this.searchQuery, collapsed: this.collapsedKeys });
    this.wireItems();
  }

  private wireItems(): void {
    this.container.querySelectorAll<HTMLButtonElement>(".device-group-header").forEach((header) => {
      header.addEventListener("click", () => this.toggleGroup(header));
    });
    this.wireDeviceButtons(".device-item .btn-edit", (id) => this.handlers.onEdit(id));
    this.wireDeviceButtons(".device-item .btn-delete", (id) => this.handlers.onDelete(id));
  }

  private wireDeviceButtons(selector: string, handler: (deviceId: string) => void): void {
    this.container.querySelectorAll<HTMLButtonElement>(selector).forEach((button) => {
      button.addEventListener("click", () => withDeviceId(button, handler));
    });
  }

  /** Collapse or expand a section in place (keeping focus on its header). */
  private toggleGroup(header: HTMLButtonElement): void {
    const collapsed = this.flipCollapsed(header.dataset.groupKey ?? "");
    header.setAttribute("aria-expanded", String(!collapsed));
    const items = this.container.querySelector<HTMLElement>(`#${header.getAttribute("aria-controls")}`);
    if (items) items.hidden = collapsed;
    this.handlers.onPersist();
  }

  /** Flip a section's collapsed state; returns whether it is now collapsed. */
  private flipCollapsed(key: string): boolean {
    if (this.collapsedKeys.delete(key)) return false;
    this.collapsedKeys.add(key);
    return true;
  }
}

function withDeviceId(button: HTMLButtonElement, handler: (deviceId: string) => void): void {
  const deviceId = button.dataset.deviceId;
  if (deviceId) handler(deviceId);
}
