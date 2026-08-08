import type { FileEntry } from "@/types/files";

/** Numeric-aware and case-insensitive, so `file2` sorts before `file10`. */
const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/** Directories first, then files, each alphabetically. */
export function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "directory" ? -1 : 1;
    }
    return collator.compare(left.name, right.name);
  });
}

export function matchesFilter(entry: FileEntry, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }
  return entry.name.toLowerCase().includes(needle);
}

export function parentPath(relativePath: string): string {
  const cut = relativePath.lastIndexOf("/");
  return cut === -1 ? "" : relativePath.slice(0, cut);
}

export function joinPath(directory: string, name: string): string {
  return directory.length === 0 ? name : `${directory}/${name}`;
}

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
