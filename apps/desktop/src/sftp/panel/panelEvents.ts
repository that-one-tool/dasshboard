/** Routes the Files panel's DOM events to its handlers: the path input's
 * Enter/Escape, the device picker, the filter (wired on each markup build),
 * and clicks on `data-action` controls (delegated from the panel root, which
 * survives a rebuild, so wired once). */

import type { SortKey } from "./entryView";
import type { PanelElements } from "./panelElements";

export interface PanelEventHandlers {
  /** Enter in the path input. */
  onPathEnter: (path: string) => void;
  /** Escape in the path input (it then loses focus). */
  onPathEscape: () => void;
  onDeviceChange: (deviceId: string) => void;
  onFilter: (text: string) => void;
}

export type ActionHandler = (action: string, target: Element) => void;

type PathKeyHandler = (event: KeyboardEvent, path: HTMLInputElement, handlers: PanelEventHandlers) => void;

const PATH_KEYS: Record<string, PathKeyHandler> = {
  Enter: (event, path, handlers) => {
    event.preventDefault();
    handlers.onPathEnter(path.value);
  },
  Escape: (event, path, handlers) => {
    event.stopPropagation();
    handlers.onPathEscape();
    path.blur();
  },
};

const SORT_KEYS: readonly string[] = ["name", "size", "modified"] satisfies SortKey[];

/** Wire the controls of a freshly built markup (call after every build). */
export function wireControlEvents(els: PanelElements, handlers: PanelEventHandlers): void {
  const { path, deviceSelect, filter } = els;
  path.addEventListener("keydown", (event) => PATH_KEYS[event.key]?.(event, path, handlers));
  deviceSelect.addEventListener("change", () => selectDevice(deviceSelect.value, handlers));
  filter.addEventListener("input", () => handlers.onFilter(filter.value));
}

/** Delegate `data-action` clicks inside `root` to `onAction`. Call once per
 * root: a second call would run every action twice. */
export function wireActionClicks(root: HTMLElement, onAction: ActionHandler): void {
  root.addEventListener("click", (event) => dispatchAction(event.target, onAction));
}

/** Run `action` with the path of the clicked control's `data-path` holder. */
export function withPath(target: Element, action: (path: string) => void): void {
  const path = target.closest<HTMLElement>("[data-path]")?.dataset.path;
  if (path) action(path);
}

/** Run `action` with the clicked transfer row's id. */
export function withTransferId(target: Element, action: (id: number) => void): void {
  const id = Number(target.closest<HTMLElement>("[data-tx-id]")?.dataset.txId);
  if (Number.isFinite(id)) action(id);
}

/** Run `action` with the clicked sort header's key. */
export function withSortKey(target: Element, action: (key: SortKey) => void): void {
  const key = target.closest<HTMLElement>("[data-sort]")?.dataset.sort;
  if (isSortKey(key)) action(key);
}

function isSortKey(key: string | undefined): key is SortKey {
  return SORT_KEYS.includes(key ?? "");
}

function selectDevice(deviceId: string, handlers: PanelEventHandlers): void {
  if (deviceId) handlers.onDeviceChange(deviceId);
}

/** `Element`, not `HTMLElement`: a click on a button's inline SVG targets an
 * `SVGElement`. */
function dispatchAction(target: EventTarget | null, onAction: ActionHandler): void {
  if (!(target instanceof Element)) return;
  const action = actionOf(target);
  if (action) onAction(action, target);
}

function actionOf(target: Element): string | undefined {
  return target.closest<HTMLElement>("[data-action]")?.dataset.action;
}
