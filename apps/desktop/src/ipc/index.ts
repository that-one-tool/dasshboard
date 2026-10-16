/**
 * Typed wrappers around Tauri `invoke` calls, one module per domain.
 *
 * SPEC.md section 10 requires every IPC payload to be defined once in `ipc/`,
 * mirroring the Rust `serde` structs (camelCase on the wire). Callers import
 * this barrel; the `invoke` helpers stay internal to `ipc/`.
 */

export * from "./errors";
export { isLocalConfigWriteRecent, markLocalConfigWrite } from "./invoke";
export * from "./config";
export * from "./devices";
export * from "./agent";
export * from "./sessions";
export * from "./knownHosts";
export * from "./tunnels";
export * from "./profiles";
export * from "./workspace";
export * from "./settings";
export * from "./updates";
export * from "./tray";
export * from "./transfer";
export * from "./sftp";
export * from "./sftpEdit";
