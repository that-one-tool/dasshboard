/** "Keep both" tries `name (2)` … `name (101)` before giving up. */
export const MAX_FREE_NAME_TRIES = 100;

/**
 * The first `<path> (2)`, `<path> (3)`, … that `exists` says is free (`path`
 * itself is known to be taken), or `null` after {@link MAX_FREE_NAME_TRIES}:
 * a server answering every stat with success would otherwise loop forever.
 */
export async function findFreeName(
  path: string,
  exists: (candidate: string) => Promise<boolean>,
): Promise<string | null> {
  for (let i = 2; i < 2 + MAX_FREE_NAME_TRIES; i++) {
    const candidate = `${path} (${i})`;
    if (!(await exists(candidate))) return candidate;
  }
  return null;
}
