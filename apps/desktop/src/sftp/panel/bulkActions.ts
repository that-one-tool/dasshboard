/** The bulk bar's actions on the selected entries: download, cut + paste
 * (a server-side move), and delete. Each captures the selection with its
 * device and directory before a dialog, and does nothing when another
 * connection took over meanwhile. */

import { sftpRename, type ConflictPolicy, type SftpEntry } from "../../ipc";
import { t, tp } from "../../i18n";
import { confirm } from "../../ui/confirm";
import { pickDownloadDirPath } from "../../ui/fileDialog";
import { joinRemote } from "../sftpFormat";
import { getBulkOutcome, runEach, type BulkResult } from "./bulkRun";
import type { DirectoryBrowser } from "./directoryBrowser";
import type { EntryList } from "./entryList";
import { removeEntry } from "./entryOperations";
import { planMoves, type MoveClipboard, type MoveSource, type MoveStep } from "./moveClipboard";
import type { PanelControls } from "./panelControls";
import type { PanelFeedback } from "./panelFeedback";
import type { PanelSession } from "./panelSession";
import type { TransferActions } from "./transferActions";
import { bulkConflictMessage, resolveLocalTargets, resolvePolicy, type LocalTarget } from "./transferConflicts";

export interface BulkDeps {
  session: PanelSession;
  browser: DirectoryBrowser;
  list: EntryList;
  controls: PanelControls;
  feedback: PanelFeedback;
  transfers: TransferActions;
  clipboard: MoveClipboard;
}

/** Selected entries and where they were listed. */
interface BulkSelection {
  deviceId: string;
  dir: string;
  entries: SftpEntry[];
}

export class BulkActions {
  constructor(private readonly deps: BulkDeps) {}

  /** Download every selected entry into one chosen local folder — files
   * directly, folders recursively — under a single conflict policy. */
  async download(): Promise<void> {
    const selection = this.downloadableSelection();
    if (!selection) return;
    const dest = await pickDownloadDirPath();
    if (dest !== null) await this.downloadInto(selection, dest);
  }

  /** "Cut": record the selection for a later Paste, then clear it. */
  cut(): void {
    const { session, list } = this.deps;
    if (session.activeDeviceId === null || list.selection.size === 0) return;
    const names = list.selection.names();
    this.deps.clipboard.cut({ deviceId: session.activeDeviceId, dir: this.deps.browser.cwd(), names });
    this.deps.controls.setStatus(tp("sftp.cutNotice", names.length));
    list.clearSelection(); // also refreshes the bar (Paste now shown after navigating)
  }

  /** "Paste": move each cut entry into the current directory (server-side
   * rename). Same-connection only; conflicts surface per item. */
  async paste(): Promise<void> {
    const source = this.pasteSource();
    if (source === null) return;
    if (source.dir === this.deps.browser.cwd()) return this.dropCut();
    await this.moveInto(source, this.deps.browser.cwd());
  }

  /** Delete every selected entry (folders recursively) after one confirmation. */
  async delete(): Promise<void> {
    const selection = this.captureSelection();
    if (!selection) return;
    if (await confirmDeleteMany(selection.entries.length)) await this.deleteEntries(selection);
  }

  /** The selection, or `null` when there is none, not connected, or a name
   * can't be stored locally (reported). */
  private downloadableSelection(): BulkSelection | null {
    const selection = this.captureSelection();
    if (!selection) return null;
    this.deps.list.clearHover();
    return this.deps.transfers.refuseUnsafeNames(selection.entries) ? null : selection;
  }

  /** The selected entries with the device and directory they belong to,
   * captured before a dialog: the connection may change while it is open. */
  private captureSelection(): BulkSelection | null {
    const entries = this.deps.list.selected();
    const place = this.deps.browser.place();
    if (place === null || entries.length === 0) return null;
    return { ...place, entries };
  }

  /**
   * Queue each entry as its own background item; they drain one at a time
   * while browsing stays live. The conflict policy is asked once for the
   * batch; skip/rename are resolved per file when it runs.
   */
  private async downloadInto(selection: BulkSelection, dest: string): Promise<void> {
    if (!this.deps.session.isConnectedTo(selection.deviceId)) return;
    const { targets, conflict } = await resolveLocalTargets(selection.entries, dest);
    const policy = await this.batchPolicy(selection, conflict);
    if (policy === null) return;
    this.queueAll(selection, targets, policy);
    this.deps.list.clearSelection();
  }

  /** The batch's conflict policy, or `null` when cancelled or when another
   * connection took over while the conflict dialog was open. */
  private async batchPolicy({ deviceId, entries }: BulkSelection, conflict: boolean): Promise<ConflictPolicy | null> {
    const policy = await resolvePolicy(conflict, bulkConflictMessage(entries));
    return this.deps.session.isConnectedTo(deviceId) ? policy : null;
  }

  private queueAll({ deviceId, dir }: BulkSelection, targets: LocalTarget[], policy: ConflictPolicy): void {
    for (const { entry, target } of targets) {
      this.deps.transfers.queueBulkItem(deviceId, joinRemote(dir, entry.name), entry, target, policy);
    }
  }

  /** The pending cut, when it belongs to the connected device. */
  private pasteSource(): MoveSource | null {
    const source = this.deps.clipboard.pending();
    return source?.deviceId === this.deps.session.activeDeviceId ? source : null;
  }

  /** Pasting where the cut came from moves nothing. */
  private dropCut(): void {
    this.deps.clipboard.clear();
    this.deps.list.updateBulkBar();
  }

  private async moveInto(source: MoveSource, dir: string): Promise<void> {
    const steps = planMoves(source, dir, new Set(this.deps.list.names()));
    this.deps.controls.setBusy(true);
    let result: BulkResult = { done: 0, firstError: null };
    try {
      result = await runEach(steps, (step) => runMoveStep(source.deviceId, step));
    } finally {
      this.deps.clipboard.clear();
      await this.deps.browser.loadDir(dir); // reflect the moved entries; also setBusy(false)
      this.finishBulk(tp("sftp.moved", result.done), result);
    }
  }

  /** Hold `busy` for the whole loop, so the listing can't change under it. */
  private async deleteEntries({ deviceId, dir, entries }: BulkSelection): Promise<void> {
    if (!this.deps.session.isConnectedTo(deviceId)) return;
    this.deps.list.clearHover();
    this.deps.controls.setBusy(true);
    const result = await runEach(entries, (entry) => removeEntry(deviceId, dir, entry));
    await this.deps.browser.loadDir(dir); // re-lists + clears `busy`
    this.finishBulk(tp("sftp.deleted", result.done), result);
  }

  /** Shared bulk-op epilogue: a success status/toast, or a partial-failure
   * status plus the first error surfaced. */
  private finishBulk(successMessage: string, result: BulkResult): void {
    const outcome = getBulkOutcome(result);
    if (outcome === "partial") return this.reportPartial(result);
    if (outcome === "success") this.announce(successMessage);
  }

  private reportPartial(result: BulkResult): void {
    this.deps.controls.setStatus(t("sftp.bulk.partial"));
    this.deps.feedback.report(result.firstError);
  }

  private announce(message: string): void {
    this.deps.controls.setStatus(message);
    this.deps.feedback.success(message);
  }
}

function confirmDeleteMany(count: number): Promise<boolean> {
  return confirm(tp("sftp.deleteConfirm", count), {
    title: t("sftp.delete.title"),
    confirmLabel: t("common.delete"),
    danger: true,
  });
}

async function runMoveStep(deviceId: string, step: MoveStep): Promise<void> {
  if ("error" in step) throw step.error;
  await sftpRename(deviceId, step.from, step.to);
}
