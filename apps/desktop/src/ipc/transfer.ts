import { invokeChecked, invokeMutation } from "./invoke";

/* ============================================================================
 * Import / export commands (SPEC §5, JSON transfer)
 * ============================================================================ */

/**
 * Exports all devices to the given path as a self-describing JSON envelope
 * (never including secrets — those live in the OS keyring). Returns the number
 * of devices written. `path` comes from the native save dialog (`fileDialog`).
 */
export async function exportDevices(path: string): Promise<number> {
  return invokeChecked<number>("export_devices", { path });
}

/** A setting an imported device would act with on this machine (mirrors
 * `transfer::ImportRisk`). */
export type ImportRisk =
  | "agentForwarding"
  | "autoStartForwards"
  | "autoStartRemoteForwards"
  | "customShell"
  | "localSnippet"
  | "networkKeyPath"
  | "networkSerialPort"
  | "networkShellDir"
  | "replacesForwards";

/** One imported device's risky settings (mirrors `transfer::DeviceRisks`). */
export interface DeviceRisks {
  name: string;
  risks: ImportRisk[];
}

/**
 * Validates the devices file at `path` (as the import will) and lists the
 * devices whose settings the user should confirm before importing.
 */
export async function previewDevicesImport(path: string): Promise<DeviceRisks[]> {
  return invokeChecked<DeviceRisks[]>("preview_devices_import", { path });
}

/**
 * Imports devices from the JSON file at `path` (upsert by id, all-or-nothing on
 * validation). Returns the number of devices imported. `path` comes from the
 * native open dialog (`fileDialog`); `confirmedRisks` is what the user agreed
 * to from `previewDevicesImport` (the backend refuses a file that no longer
 * matches it).
 */
export async function importDevices(
  path: string,
  confirmedRisks: DeviceRisks[],
): Promise<number> {
  return invokeMutation<number>("import_devices", { path, confirmedRisks });
}

/**
 * Exports all profiles to the given path as a self-describing JSON envelope
 * (the per-machine `defaultProfileId` is intentionally excluded). Returns the
 * number of profiles written.
 */
export async function exportProfiles(path: string): Promise<number> {
  return invokeChecked<number>("export_profiles", { path });
}

/**
 * Imports profiles from the JSON file at `path` (upsert by id, all-or-nothing on
 * validation; leaves `defaultProfileId` untouched). Returns the number of
 * profiles imported.
 */
export async function importProfiles(path: string): Promise<number> {
  return invokeMutation<number>("import_profiles", { path });
}

/**
 * Writes `contents` to the text file at `path` (a terminal's saved output;
 * `path` comes from the native save dialog, `pickTextSavePath`).
 */
export async function saveTextFile(path: string, contents: string): Promise<void> {
  return invokeChecked<void>("save_text_file", { path, contents });
}

/** Result of an SSH-config import: how many devices were added vs. skipped
 * (a wildcard/`Match`-only block, an entry that produced no valid device, or a
 * duplicate of one already saved). */
export interface SshImportSummary {
  imported: number;
  skipped: number;
}

/**
 * Imports SSH devices from an OpenSSH client config (typically `~/.ssh/config`)
 * at `path`. Best-effort, upsert into the device store: each concrete `Host`
 * block becomes an SSH device; hosts that don't validate or duplicate an
 * existing device are skipped, not fatal. `path` comes from the native open
 * dialog (`pickSshConfigOpenPath`). Returns the imported/skipped counts.
 */
export async function importSshConfig(
  path: string,
): Promise<SshImportSummary> {
  return invokeMutation<SshImportSummary>("import_ssh_config", { path });
}

/** Result of an SSH-config export: how many SSH devices were written vs. how
 * many non-SSH devices (serial / local shell) were skipped. */
export interface SshExportSummary {
  exported: number;
  skipped: number;
}

/**
 * Exports every SSH device to an OpenSSH client config at `path` (the reverse of
 * `importSshConfig`). Non-SSH devices are skipped. Never writes secret material.
 * `path` comes from the native save dialog (`pickSshConfigSavePath`). Returns
 * the exported/skipped counts. Not a config-store write, so no echo suppression.
 */
export async function exportSshConfig(
  path: string,
): Promise<SshExportSummary> {
  return invokeChecked<SshExportSummary>("export_ssh_config", { path });
}
