/**
 * Directories that are shown in the tree but never walked into.
 *
 * `@pierre/trees` is path-first: it wants every path up front, with no
 * expand-on-demand hook. Descending into `node_modules` would mean shipping
 * six figures of paths that nobody is looking for. Listing the directory
 * itself keeps the tree honest about what is on disk without paying for its
 * contents.
 */
export const UNWALKED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
]);

export function shouldDescend(directoryName: string): boolean {
  return !UNWALKED_DIRECTORIES.has(directoryName);
}

/**
 * The path form the tree expects: directories carry a trailing slash so an
 * empty one still appears as a folder rather than vanishing.
 */
export function toTreePath(relativePath: string, isDirectory: boolean): string {
  return isDirectory ? `${relativePath}/` : relativePath;
}

export function isDirectoryTreePath(treePath: string): boolean {
  return treePath.endsWith("/");
}

/** Strips the marker so a tree path can be handed back to the file APIs. */
export function toRelativePath(treePath: string): string {
  return treePath.endsWith("/") ? treePath.slice(0, -1) : treePath;
}
