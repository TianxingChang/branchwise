export const DEFAULT_SCROLLBACK_LIMIT = 200_000;

/**
 * Bounded scrollback for a terminal session.
 *
 * The buffer exists so that re-opening the Terminal tab shows what already
 * happened instead of an empty screen. Trimming prefers a line boundary: a cut
 * in the middle of an escape sequence would leave xterm interpreting the tail
 * of a colour code as text.
 */
export function appendToScrollback(
  existing: string,
  chunk: string,
  limit = DEFAULT_SCROLLBACK_LIMIT
): string {
  const combined = existing + chunk;
  if (combined.length <= limit) {
    return combined;
  }

  const overflow = combined.length - limit;
  const newline = combined.indexOf("\n", overflow);

  return newline === -1
    ? combined.slice(overflow)
    : combined.slice(newline + 1);
}
