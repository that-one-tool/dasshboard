/** The Files panel's controls, queried once per (re)build of its markup. */

import { sftpPanelMarkup } from "./panelTemplate";

export interface PanelElements {
  root: HTMLElement;
  deviceSelect: HTMLSelectElement;
  connDot: HTMLElement;
  connToggle: HTMLButtonElement;
  path: HTMLInputElement;
  back: HTMLButtonElement;
  forward: HTMLButtonElement;
  bookmarkToggle: HTMLElement;
  bookmarks: HTMLElement;
  filter: HTMLInputElement;
  bulkBar: HTMLElement;
  selectAll: HTMLInputElement;
  selCount: HTMLElement;
  pasteBtn: HTMLButtonElement;
  list: HTMLElement;
  edits: HTMLElement;
  queue: HTMLElement;
  status: HTMLElement;
}

/** Fill `root` with the panel markup (current locale) and return its controls. */
export function buildPanelElements(root: HTMLElement): PanelElements {
  root.innerHTML = sftpPanelMarkup();
  return { root, ...headerElements(root), ...listElements(root), ...footerElements(root) };
}

function headerElements(root: HTMLElement) {
  return {
    deviceSelect: pick<HTMLSelectElement>(root, ".sftp-device-select"),
    connDot: pick<HTMLElement>(root, ".sftp-conn-dot"),
    connToggle: pick<HTMLButtonElement>(root, ".sftp-conn-toggle"),
    path: pick<HTMLInputElement>(root, ".sftp-path"),
    back: pick<HTMLButtonElement>(root, '[data-action="back"]'),
    forward: pick<HTMLButtonElement>(root, '[data-action="forward"]'),
    bookmarkToggle: pick<HTMLElement>(root, ".sftp-bookmark-toggle"),
    bookmarks: pick<HTMLElement>(root, ".sftp-bookmarks"),
  };
}

function listElements(root: HTMLElement) {
  return {
    filter: pick<HTMLInputElement>(root, ".sftp-filter"),
    bulkBar: pick<HTMLElement>(root, ".sftp-bulkbar"),
    selectAll: pick<HTMLInputElement>(root, '[data-action="select-all"]'),
    selCount: pick<HTMLElement>(root, ".sftp-sel-count"),
    pasteBtn: pick<HTMLButtonElement>(root, ".sftp-bulk-paste"),
    list: pick<HTMLElement>(root, ".sftp-entries"),
  };
}

function footerElements(root: HTMLElement) {
  return {
    edits: pick<HTMLElement>(root, ".sftp-edits"),
    queue: pick<HTMLElement>(root, ".sftp-queue"),
    status: pick<HTMLElement>(root, ".sftp-status"),
  };
}

function pick<T extends Element>(root: HTMLElement, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`sftp panel markup lacks ${selector}`);
  return element;
}
