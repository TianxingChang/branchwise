import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  shouldDescend,
  toTreePath,
  UNWALKED_DIRECTORIES,
} from "@/lib/files/scan-policy";

/** Beyond this the tree stops being something a person can navigate. */
export const DEFAULT_PATH_LIMIT = 20_000;

export interface ScanResult {
  paths: string[];
  truncated: boolean;
}

/**
 * Collects every path in a worktree as a flat list.
 *
 * Breadth-first on purpose: if a repository is large enough to hit the limit,
 * the paths that survive are the shallow ones people actually navigate, rather
 * than an arbitrary deep corner of whichever directory happened to sort first.
 */
export async function scanWorktree(
  root: string,
  options: { limit?: number } = {}
): Promise<ScanResult> {
  const limit = options.limit ?? DEFAULT_PATH_LIMIT;
  const paths: string[] = [];
  const queue: string[] = [""];

  while (queue.length > 0) {
    const relative = queue.shift() as string;
    const absolute = relative.length === 0 ? root : path.join(root, relative);

    let entries: Dirent<string>[];
    try {
      // biome-ignore lint/performance/noAwaitInLoops: a breadth-first walk is sequential by definition
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      continue; // Vanished or unreadable between queueing and now.
    }

    for (const entry of entries) {
      if (paths.length >= limit) {
        return { paths, truncated: true };
      }

      const childRelative =
        relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      const isDirectory = entry.isDirectory();

      paths.push(toTreePath(childRelative, isDirectory));

      if (isDirectory && shouldDescend(entry.name)) {
        queue.push(childRelative);
      }
    }
  }

  return { paths, truncated: false };
}

/** True when a change under this path is not worth telling the tree about. */
export function isInsideUnwalkedDirectory(relativePath: string): boolean {
  return relativePath
    .split("/")
    .some((segment, index, segments) =>
      index < segments.length - 1 ? UNWALKED_DIRECTORIES.has(segment) : false
    );
}
