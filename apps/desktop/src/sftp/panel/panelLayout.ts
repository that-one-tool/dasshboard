/**
 * The Files panel's visibility and width: hidden, open, or open but collapsed
 * to its rail. Persisted only once the panel was first opened, so the
 * workspace file stays clean until the feature is used.
 */

import type { SftpPanelState } from "../../ipc";

export interface WidthRange {
  min: number;
  max: number;
}

export class PanelLayout {
  private open = false;
  private collapsed = false;
  private everOpened = false;

  constructor(private currentWidth: number) {}

  isOpen(): boolean {
    return this.open;
  }

  isCollapsed(): boolean {
    return this.collapsed;
  }

  width(): number {
    return this.currentWidth;
  }

  /** Apply a saved state; `true` when it reopens the panel. */
  restore(saved: SftpPanelState, range: WidthRange): boolean {
    this.currentWidth = Math.min(range.max, Math.max(range.min, saved.width));
    if (!saved.open) return false;
    this.show();
    this.collapsed = saved.collapsed;
    return true;
  }

  /** Open, expanded. */
  show(): void {
    this.open = true;
    this.everOpened = true;
    this.collapsed = false;
  }

  hide(): void {
    this.open = false;
  }

  /** `false` (and no change) while the panel is hidden. */
  setCollapsed(collapsed: boolean): boolean {
    if (!this.open) return false;
    this.collapsed = collapsed;
    return true;
  }

  resize(width: number): void {
    this.currentWidth = width;
  }

  persisted(deviceId: string | null): SftpPanelState | undefined {
    if (!this.everOpened) return undefined;
    return { open: this.open, collapsed: this.collapsed, width: this.currentWidth, deviceId };
  }
}
