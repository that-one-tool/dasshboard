import { invokeChecked, invokeMutation } from "./invoke";

/**
 * One trusted-host row from the known-hosts store (management UI). `id` is the
 * composite `host:port` key — used both as the display label and as the handle
 * passed back to `forgetHost`. Fingerprints are public data, never secrets.
 */
export interface KnownHostEntry {
  id: string;
  keyType: string;
  fingerprint: string;
}

/** Lists every trusted host key, sorted by `id` (`host:port`). */
export async function listKnownHosts(): Promise<KnownHostEntry[]> {
  return invokeChecked<KnownHostEntry[]>("list_known_hosts");
}

/**
 * Forgets a trusted host by its `host:port` id. Forgetting an id that is
 * already gone is not an error (the backend returns `Ok`); the next connect to
 * that host will TOFU-prompt again.
 */
export async function forgetHost(id: string): Promise<void> {
  await invokeMutation<void>("forget_host", { id });
}

/** When the trusted hosts were reset after a damaged file (unix seconds), or
 * `null` when they weren't or the user dismissed it. */
export async function knownHostsReset(): Promise<number | null> {
  return invokeChecked<number | null>("known_hosts_reset");
}

/** Acknowledge the trusted hosts reset: unknown hosts are plain first contacts again. */
export async function dismissKnownHostsReset(): Promise<void> {
  await invokeMutation<void>("dismiss_known_hosts_reset");
}
