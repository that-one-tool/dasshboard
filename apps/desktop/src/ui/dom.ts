/**
 * Small DOM helpers shared across the UI modules.
 */

/**
 * Looks up a required descendant by selector, throwing a clear error if it is
 * missing rather than returning `null` (or forcing an `as` cast past `strict`
 * null-checking at every call site).
 *
 * Every element queried through this helper is part of the static markup its
 * module renders, so a miss means the markup and the code have drifted — which
 * should fail loudly and immediately instead of surfacing later as a
 * `Cannot read properties of null`. The type parameter `E` picks the returned
 * element type, e.g. `requireEl<HTMLInputElement>(form, "#name")`.
 */
export function requireEl<E extends Element>(
  root: ParentNode,
  selector: string,
): E {
  const el = root.querySelector<E>(selector);
  if (!el) throw new Error(`Expected element not found: ${selector}`);
  return el;
}
