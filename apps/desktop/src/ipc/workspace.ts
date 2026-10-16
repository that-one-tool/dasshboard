import type { GridModel } from "../gridModel";
import { invokeChecked } from "./invoke";
import type { ProfilePane } from "./profiles";

/* ============================================================================
 * Workspace state (Tabs milestone, Phase 3)
 *
 * Per-instance open-tabs layout, persisted to `workspace_state.json`. Separate
 * from profiles and NOT part of the multi-instance config sync — so these use
 * plain `invokeChecked` (no `markLocalConfigWrite`): the backend deliberately
 * excludes `workspace_state.json` from the config file-watcher.
 * ============================================================================ */

/** One saved tab: display name, grid layout, row-major panes, linked profile. */
export interface WorkspaceTabState {
  name: string;
  grid: GridModel;
  panes: ProfilePane[];
  linkedProfileId: string | null;
}

/** The docked Files (SFTP) panel's per-instance UI state (open/collapsed/width
 * + last-selected device, preselected on restore but not auto-reconnected). */
export interface SftpPanelState {
  open: boolean;
  collapsed: boolean;
  width: number;
  deviceId: string | null;
}

/** The saved open-tabs workspace. Empty `tabs` means nothing persisted yet. */
export interface WorkspaceState {
  tabs: WorkspaceTabState[];
  activeIndex: number;
  /** The Files panel's UI state, or absent/undefined before it has been used. */
  sftp?: SftpPanelState;
  /** The left menu's width in px, or absent while the CSS default applies. */
  sidebarWidth?: number;
  /** True while the left menu is collapsed to its thin bar; absent otherwise. */
  sidebarCollapsed?: boolean;
  /** Device id → which of its forwards the user last left running (explicit
   * Start/Stop): the listed forward ids, or none (`false`); `true` (all) only
   * in older files. Absent devices follow their `tunnelAutoStart` flag. */
  tunnels?: Record<string, boolean | string[]>;
  /** The device list's collapsed tag sections, by lowercased tag (`""` for the
   * untagged one); absent while none are collapsed. */
  collapsedDeviceGroups?: string[];
}

/** The saved workspace, or an empty one (no tabs) on first launch / corrupt file. */
export async function getWorkspaceState(): Promise<WorkspaceState> {
  return invokeChecked<WorkspaceState>("get_workspace_state");
}

/** Persists the open-tabs workspace (validated + atomic on the backend). */
export async function saveWorkspaceState(workspace: WorkspaceState): Promise<void> {
  await invokeChecked<void>("save_workspace_state", { workspace });
}
