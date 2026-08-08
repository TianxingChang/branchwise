import { eventIterator, os } from "@orpc/server";
import { z } from "zod";
import { repoInfoSchema, repoSnapshotSchema } from "@/types/branch";
import { initRepo, resolveRepo } from "./repo";
import { acquireWatcher, releaseWatcher } from "./watcher";

const folderInput = z.object({ path: z.string().min(1) });

/** Returns null when the folder is not inside a git repository. */
export const resolve = os
  .input(folderInput)
  .output(repoInfoSchema.nullable())
  .handler(({ input }) => resolveRepo(input.path));

export const init = os
  .input(folderInput)
  .output(repoInfoSchema.nullable())
  .handler(({ input }) => initRepo(input.path));

/**
 * Streams a full snapshot on subscribe and again on every change git makes.
 *
 * The generator ends when the renderer aborts the call — closing a tab or
 * reloading the window — at which point the last subscriber releases the
 * watcher and its filesystem handles go away.
 */
export const watch = os
  .input(folderInput)
  .output(eventIterator(repoSnapshotSchema))
  .handler(async function* ({ input, signal }) {
    const repo = await resolveRepo(input.path);
    if (!repo) {
      return;
    }

    const watcher = await acquireWatcher(repo);
    try {
      for await (const snapshot of watcher.follow(signal)) {
        yield snapshot;
      }
    } finally {
      releaseWatcher(repo);
    }
  });
