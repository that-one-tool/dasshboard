/** The connected device's bookmarked directories: the chip row and the
 * toolbar star that adds or removes the current directory. */

import { sftpBookmarkAdd, sftpBookmarkRemove, sftpBookmarks } from "../../ipc";
import { renderBookmarks, renderBookmarkToggle } from "./bookmarksBar";
import type { PanelElements } from "./panelElements";
import type { PanelFeedback } from "./panelFeedback";
import type { PanelSession } from "./panelSession";

export interface BookmarksDeps {
  els: () => PanelElements;
  session: PanelSession;
  feedback: PanelFeedback;
  cwd: () => string;
}

export class PanelBookmarks {
  /** The connected device's saved bookmark paths (loaded on connect). */
  private paths: string[] = [];

  constructor(private readonly deps: BookmarksDeps) {}

  /** Load the device's bookmarks and render them. Non-fatal: a failure just
   * leaves the bar empty (bookmarks are a convenience). */
  async load(deviceId: string): Promise<void> {
    try {
      this.paths = await sftpBookmarks(deviceId);
    } catch {
      this.paths = [];
    }
    this.render();
  }

  /** Forget them (bookmarks are loaded per active device). */
  clear(): void {
    this.paths = [];
    this.render();
  }

  /** Render the chips and the star for the current directory. */
  render(): void {
    const { bookmarks, bookmarkToggle } = this.deps.els();
    renderBookmarkToggle(bookmarkToggle, this.isMarked());
    // Chips are hidden when not connected; the current directory is highlighted.
    const paths = this.deps.session.isConnected() ? this.paths : [];
    renderBookmarks(bookmarks, paths, this.deps.cwd());
  }

  /** Bookmark (or un-bookmark) the current directory. */
  async toggle(): Promise<void> {
    const deviceId = this.deps.session.activeDeviceId;
    if (deviceId === null) return;
    await this.save(() => this.toggled(deviceId, this.deps.cwd()));
  }

  /** Remove a bookmark from its chip's × button. */
  async remove(path: string): Promise<void> {
    const deviceId = this.deps.session.activeDeviceId;
    if (deviceId === null) return;
    await this.save(() => sftpBookmarkRemove(deviceId, path));
  }

  private isMarked(): boolean {
    return this.deps.session.isConnected() && this.paths.includes(this.deps.cwd());
  }

  private toggled(deviceId: string, dir: string): Promise<string[]> {
    return this.paths.includes(dir) ? sftpBookmarkRemove(deviceId, dir) : sftpBookmarkAdd(deviceId, dir);
  }

  private async save(change: () => Promise<string[]>): Promise<void> {
    await this.deps.feedback.attempt(async () => {
      this.paths = await change();
      this.render();
    });
  }
}
