/**
 * Pure validation for SSH port-forwards, mirroring the Rust `validate_forwards`
 * rules (SPEC §1). No DOM access — the T3 forwarding editor calls these to block
 * an invalid save and highlight the offending row; the backend remains the
 * source of truth.
 */

import type { Forward } from "../ipc";
import type { ValidationError } from "./validation";

/** Default local bind address when the field is left blank (matches the Rust default). */
export const DEFAULT_LOCAL_ADDR = "127.0.0.1";

const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * The loose, all-optional shape a forward row produces before it is a valid
 * `Forward` (a half-filled editor row).
 */
export type ForwardFormValues = Partial<Forward>;

/** An integer in 1..=65535. */
function isValidPort(port: number | undefined): boolean {
  return (
    port !== undefined &&
    Number.isInteger(port) &&
    port >= MIN_PORT &&
    port <= MAX_PORT
  );
}

/**
 * Whether `addr` is a loopback address, matching Rust's `IpAddr::is_loopback`:
 * IPv4 `127.0.0.0/8` or IPv6 `::1`. Any other value (including a malformed one)
 * is rejected.
 */
export function isLoopbackAddress(addr: string): boolean {
  const trimmed = addr.trim();
  if (trimmed === "::1") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(trimmed);
  if (!match) return false;
  const octets = match.slice(1, 5).map((o) => Number(o));
  if (octets.some((o) => o > 255)) return false;
  return octets[0] === 127;
}

/** The `(localAddr, localPort)` bind pair a forward claims, addr defaulted. */
function bindKey(forward: ForwardFormValues): string {
  const addr = (forward.localAddr ?? "").trim() || DEFAULT_LOCAL_ADDR;
  return `${addr}:${forward.localPort ?? ""}`;
}

function pushIfEmpty(
  errors: ValidationError[],
  value: string | undefined,
  field: string,
  message: string,
): void {
  if (!value || value.trim() === "") errors.push({ field, message });
}

function pushIfInvalidPort(
  errors: ValidationError[],
  port: number | undefined,
  field: string,
): void {
  if (!isValidPort(port)) {
    errors.push({ field, message: "Port must be a number between 1 and 65535" });
  }
}

function pushIfNotLoopback(
  errors: ValidationError[],
  localAddr: string | undefined,
  field: string,
): void {
  const addr = (localAddr ?? "").trim() || DEFAULT_LOCAL_ADDR;
  if (!isLoopbackAddress(addr)) {
    errors.push({
      field,
      message: "Local address must be a loopback address (e.g. 127.0.0.1)",
    });
  }
}

/** Field-level rules for one forward; `prefix` namespaces the error fields. */
function forwardFieldErrors(
  forward: ForwardFormValues,
  prefix: string,
): ValidationError[] {
  const errors: ValidationError[] = [];
  pushIfEmpty(errors, forward.name, `${prefix}-name`, "Name is required");
  pushIfEmpty(
    errors,
    forward.remoteHost,
    `${prefix}-remoteHost`,
    "Remote host is required",
  );
  pushIfInvalidPort(errors, forward.localPort, `${prefix}-localPort`);
  pushIfInvalidPort(errors, forward.remotePort, `${prefix}-remotePort`);
  pushIfNotLoopback(errors, forward.localAddr, `${prefix}-localAddr`);
  return errors;
}

/**
 * Validates a list of forwards: every forward's fields, plus the rule that no
 * two forwards may claim the same `(localAddr, localPort)` bind pair. Error
 * fields are namespaced `forward-<index>-<field>` so the editor can mark the
 * right row. Empty list ⇒ no errors.
 */
export function validateForwards(
  forwards: ForwardFormValues[],
): ValidationError[] {
  const errors: ValidationError[] = [];
  const seen = new Set<string>();
  forwards.forEach((forward, index) => {
    const prefix = `forward-${index}`;
    errors.push(...forwardFieldErrors(forward, prefix));
    const key = bindKey(forward);
    if (seen.has(key)) {
      errors.push({
        field: `${prefix}-localPort`,
        message: "Another forward already binds this address and port",
      });
    } else {
      seen.add(key);
    }
  });
  return errors;
}
