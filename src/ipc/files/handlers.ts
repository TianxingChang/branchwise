import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ORPCError, os } from "@orpc/server";
import { z } from "zod";
import { countLines, sortEntries } from "@/lib/files/entries";
import { PathEscapeError, safeSegments } from "@/lib/files/path-safety";
import {
  directoryListingSchema,
  type FileEntry,
  fileContentSchema,
} from "@/types/files";

/** Anything larger is not something to read in a side panel. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** Enough to catch a NUL byte, which is how git decides a file is binary. */
const SNIFF_BYTES = 8000;

const locationInput = z.object({
  path: z.string().min(1),
  worktreePath: z.string().min(1),
});

/**
 * Resolves a renderer-supplied relative path inside a worktree.
 *
 * Both ends go through `realpath`: the root so a worktree reached via a symlink
 * still compares equal, and the *target* because segment normalisation alone
 * only stops `../`. A symlink sitting inside the worktree and pointing anywhere
 * on the machine passes every textual check — resolving it is the only way to
 * see where it really goes.
 */
async function resolveInside(
  worktreePath: string,
  relativePath: string
): Promise<{ absolute: string; relative: string }> {
  const segments = safeSegments(relativePath);
  const root = await realpath(worktreePath);
  const resolved = await realpath(path.join(root, ...segments));

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new PathEscapeError(relativePath);
  }

  return { absolute: resolved, relative: segments.join("/") };
}

function asClientError(error: unknown): never {
  throw new ORPCError("BAD_REQUEST", {
    cause: error,
    message:
      error instanceof Error ? error.message : "That path could not be read.",
  });
}

export const list = os
  .input(locationInput.extend({ path: z.string() }))
  .output(directoryListingSchema)
  .handler(async ({ input }) => {
    try {
      const { absolute, relative } = await resolveInside(
        input.worktreePath,
        input.path
      );

      const found = await readdir(absolute, { withFileTypes: true });
      const entries: FileEntry[] = found.map((item) => ({
        isSymlink: item.isSymbolicLink(),
        kind: item.isDirectory() ? "directory" : "file",
        name: item.name,
        path: relative.length === 0 ? item.name : `${relative}/${item.name}`,
        size: 0,
      }));

      return { entries: sortEntries(entries), path: relative };
    } catch (error) {
      return asClientError(error);
    }
  });

export const read = os
  .input(locationInput)
  .output(fileContentSchema)
  .handler(async ({ input }) => {
    try {
      const { absolute } = await resolveInside(input.worktreePath, input.path);

      const info = await stat(absolute);
      if (info.isDirectory()) {
        throw new Error("That path is a directory.");
      }
      if (info.size > MAX_TEXT_BYTES) {
        return { kind: "too-large" as const, size: info.size };
      }

      // A NUL byte in the first few kilobytes is git's own binary test, and it
      // avoids pushing megabytes of noise into the renderer.
      const handle = await open(absolute, "r");
      try {
        const head = Buffer.alloc(Math.min(SNIFF_BYTES, info.size));
        await handle.read(head, 0, head.length, 0);
        if (head.includes(0)) {
          return { kind: "binary" as const, size: info.size };
        }
      } finally {
        await handle.close();
      }

      const text = await readFile(absolute, "utf8");
      return {
        kind: "text" as const,
        lineCount: countLines(text),
        size: info.size,
        text,
      };
    } catch (error) {
      return asClientError(error);
    }
  });
