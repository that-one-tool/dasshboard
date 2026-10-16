/* ============================================================================
 * Error type (SPEC section 5)
 * ============================================================================ */

export type ErrorCode =
  | "NotFound"
  | "Io"
  | "Keyring"
  | "Validation"
  | "SshAuth"
  | "SshConnect"
  | "SshChannel"
  | "HostKeyRejected"
  | "TunnelBind"
  | "Sftp"
  | "Cancelled"
  | "Update";

export interface AppError {
  code: ErrorCode;
  message: string;
}
