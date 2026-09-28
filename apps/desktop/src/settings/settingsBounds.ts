/**
 * The numeric settings' valid ranges — mirrors of the clamps in
 * `src-tauri/src/settings.rs`. The frontend clamps too so an out-of-range value
 * never reaches a live terminal, and a negative one never reaches the backend,
 * whose `u32` fields would reject the whole save.
 */

export interface Bounds {
  min: number;
  max: number;
}

export const FONT_SIZE: Bounds = { min: 6, max: 40 };
export const SCROLLBACK: Bounds = { min: 0, max: 100_000 };
export const KEEPALIVE_INTERVAL: Bounds = { min: 0, max: 3600 };
export const KEEPALIVE_COUNT: Bounds = { min: 1, max: 10 };
export const SFTP_IDLE_MINS: Bounds = { min: 0, max: 1440 };

/** Parse a number field: a non-numeric value keeps `fallback`, anything else is
 * clamped into `bounds`. */
export function parseBounded(raw: string, fallback: number, bounds: Bounds): number {
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, parsed));
}
