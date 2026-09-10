/**
 * Form validation logic for the device editor.
 *
 * These are pure functions (no side effects, no DOM access) that can be
 * tested independently and reused across UI components.
 */

import type { Auth, DeviceKind, FlowControl, Forward, Parity } from "../ipc";

export interface ValidationError {
  field: string;
  message: string;
}

/**
 * The loose, all-optional shape the device editor form produces before a save
 * (a partial view of either device kind). Validation and the save payload work
 * off this rather than the strict `Device` union, since a half-filled form is
 * not yet a valid device of either kind.
 */
export interface DeviceFormValues {
  kind?: DeviceKind;
  name?: string;
  // SSH
  host?: string;
  port?: number;
  username?: string;
  auth?: Auth;
  // Serial
  portName?: string;
  baudRate?: number;
  dataBits?: number;
  parity?: Parity;
  stopBits?: number;
  flowControl?: FlowControl;
  autoReconnect?: boolean;
  // SSH forwards, edited by the forwarding sub-editor.
  forwards?: Forward[];
  // Start this device's tunnel automatically on app launch (SSH only).
  tunnelAutoStart?: boolean;
}

/**
 * Validates a device's fields according to backend rules (SPEC section 4).
 * Returns an array of validation errors; empty means valid.
 *
 * Common: `name` non-empty. SSH: `host`/`username` non-empty, `port` an integer
 * in 1–65535, and `keyPath` non-empty for key auth. Serial: `portName`
 * non-empty and `baudRate` a positive integer.
 */
export function validateDevice(device: DeviceFormValues): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!device.name || device.name.trim() === "") {
    errors.push({ field: "name", message: "Name is required" });
  }

  if (device.kind === "serial") {
    validateSerial(device, errors);
  } else {
    validateSsh(device, errors);
  }

  return errors;
}

/** SSH field rules: non-empty host/username, a valid port, key-auth keyPath. */
function validateSsh(device: DeviceFormValues, errors: ValidationError[]): void {
  if (!device.host || device.host.trim() === "") {
    errors.push({ field: "host", message: "Host is required" });
  }

  if (device.port === undefined || device.port === null) {
    errors.push({ field: "port", message: "Port is required" });
  } else if (!Number.isInteger(device.port) || device.port < 1 || device.port > 65535) {
    errors.push({
      field: "port",
      message: "Port must be a number between 1 and 65535",
    });
  }

  if (!device.username || device.username.trim() === "") {
    errors.push({ field: "username", message: "Username is required" });
  }

  if (device.auth && device.auth.method === "key") {
    // `device.auth` is already narrowed to the `key` variant of the
    // discriminated union here, so `keyPath` is directly accessible — no cast.
    if (!device.auth.keyPath || device.auth.keyPath.trim() === "") {
      errors.push({
        field: "keyPath",
        message: "Key path is required for key-based authentication",
      });
    }
  }
}

/** Serial field rules: non-empty portName and a positive integer baudRate. */
function validateSerial(
  device: DeviceFormValues,
  errors: ValidationError[],
): void {
  if (!device.portName || device.portName.trim() === "") {
    errors.push({ field: "portName", message: "Port name is required" });
  }

  if (device.baudRate === undefined || device.baudRate === null) {
    errors.push({ field: "baudRate", message: "Baud rate is required" });
  } else if (!Number.isInteger(device.baudRate) || device.baudRate < 1) {
    errors.push({
      field: "baudRate",
      message: "Baud rate must be a positive number",
    });
  }
}

/**
 * Checks if a field has a validation error.
 */
export function hasFieldError(
  errors: ValidationError[],
  field: string,
): boolean {
  return errors.some((e) => e.field === field);
}

/**
 * Gets the first error message for a field, or an empty string.
 */
export function getFieldError(
  errors: ValidationError[],
  field: string,
): string {
  const error = errors.find((e) => e.field === field);
  return error?.message ?? "";
}
