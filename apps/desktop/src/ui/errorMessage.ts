/** The text to show for a caught error: an `AppError`'s or `Error`'s message,
 * else the value itself as a string. */
export function getErrorMessage(err: unknown): string {
  const message = getMessageField(err);
  return typeof message === "string" ? message : String(err);
}

function getMessageField(err: unknown): unknown {
  return typeof err === "object" && err !== null ? (err as { message?: unknown }).message : undefined;
}
