/**
 * Guards the boundary between a renderer-supplied relative path and the disk.
 *
 * The renderer names files by a path relative to the worktree, so `../../..`
 * would otherwise reach anything on the machine. Normalisation happens here,
 * without touching the filesystem, so it can be tested exhaustively.
 */
export class PathEscapeError extends Error {
  constructor(relativePath: string) {
    super(`"${relativePath}" points outside the worktree.`);
    this.name = "PathEscapeError";
  }
}

const SEPARATORS = /[\\/]+/;
const WINDOWS_DRIVE = /^[a-zA-Z]:/;

/**
 * Reduces a relative path to its plain segments, rejecting anything absolute
 * or that climbs above the root.
 */
export function safeSegments(relativePath: string): string[] {
  if (relativePath.startsWith("/") || WINDOWS_DRIVE.test(relativePath)) {
    throw new PathEscapeError(relativePath);
  }

  const segments: string[] = [];

  for (const segment of relativePath.split(SEPARATORS)) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        throw new PathEscapeError(relativePath);
      }
      segments.pop();
      continue;
    }
    if (segment.includes("\0")) {
      throw new PathEscapeError(relativePath);
    }
    segments.push(segment);
  }

  return segments;
}

export function safeRelativePath(relativePath: string): string {
  return safeSegments(relativePath).join("/");
}
