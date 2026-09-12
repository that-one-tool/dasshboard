/**
 * Pure helpers for the SFTP browser: POSIX remote-path joining and the
 * human-readable size / modified-time formatting shown in the file list. Kept
 * separate from the panel DOM so they're unit-testable without a document.
 *
 * Remote paths are always POSIX (`/`-separated), regardless of the local OS —
 * the server is what matters — so these never touch the platform separator.
 */

/**
 * Join a remote directory and a child name into a POSIX path, collapsing any
 * doubled slash at the seam. `base` of `/` yields `/name`; an empty `base` is
 * treated as root.
 */
export function joinRemote(base: string, name: string): string {
  if (base === "" || base === "/") return `/${name}`;
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${trimmed}/${name}`;
}

/**
 * The parent-directory expression for a remote path: `<path>/..`. Callers resolve
 * it server-side (`sftpRealpath`) rather than trimming the string, so it stays
 * correct through symlinks. Root maps to itself.
 */
export function parentOf(path: string): string {
  if (path === "" || path === "/") return "/";
  return `${path}/..`;
}

/** IEC size like `1.5 KiB`; bytes under 1024 show as a plain byte count. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal place, trimming a trailing `.0` (so `2 MiB`, not `2.0 MiB`).
  const rounded = value.toFixed(1).replace(/\.0$/, "");
  return `${rounded} ${units[unit]}`;
}

/**
 * Format a Unix-seconds modified time as a compact local `YYYY-MM-DD HH:MM`.
 * `undefined` (server omitted it) yields an empty string.
 */
export function formatMtime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return "";
  const d = new Date(seconds * 1000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
