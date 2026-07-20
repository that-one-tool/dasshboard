/**
 * Form validation logic for the device editor.
 *
 * These are pure functions (no side effects, no DOM access) that can be
 * tested independently and reused across UI components.
 */

import type { Device } from "../ipc";

export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validates a device's fields according to backend rules (SPEC section 4).
 *
 * Returns an array of validation errors. Empty array means valid.
 *
 * Rules:
 * - name: non-empty
 * - host: non-empty
 * - port: integer in range 1–65535
 * - username: non-empty
 * - auth.keyPath: non-empty when method is "key"
 */
export function validateDevice(device: Partial<Device>): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!device.name || device.name.trim() === "") {
    errors.push({ field: "name", message: "Name is required" });
  }

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

  return errors;
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
