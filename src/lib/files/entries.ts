const UNITS = ["B", "KB", "MB", "GB"];

export function formatBytes(size: number): string {
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${UNITS[unit]}`;
}

/**
 * Counts lines the way `wc -l` does: a trailing newline terminates the last
 * line rather than starting an empty one.
 */
export function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const parts = text.split("\n").length;
  return text.endsWith("\n") ? parts - 1 : parts;
}
