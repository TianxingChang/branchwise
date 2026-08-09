import { eventIterator, ORPCError, os } from "@orpc/server";
import { z } from "zod";
import {
  repoInfoSchema,
  repoSnapshotSchema,
  worktreeStatusSchema,
} from "@/types/branch";
import {
  changedPathSchema,
  diffSummarySchema,
  worktreeDiffSchema,
} from "@/types/diff";
import {
  worktreeChangedPaths,
  worktreeDiff,
  worktreeDiffSummary,
} from "./diff";
import {
  createWorktree,
  deleteBranch,
  pruneWorktrees,
  removeWorktree,
  renameBranch,
  worktreeStatus,
} from "./mutate";
import { initRepo, resolveRepo } from "./repo";
import { acquireWatcher, peekWatcher, releaseWatcher } from "./watcher";

/**
 * Nudges the watcher after branchwise itself changes the repo, so the canvas
 * updates immediately rather than waiting out the filesystem debounce.
 */
async function refresh(root: string) {
  await peekWatcher(root)?.poke();
}

/**
 * Surfaces a git failure's own words to the renderer.
 *
 * oRPC masks anything that is not an ORPCError as "Internal server error", so
 * without this the user is told nothing useful — not that the branch already
 * exists, not that the worktree path is taken.
 */
async function expose<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      cause: error,
      message:
        error instanceof Error ? error.message : "The git command failed.",
    });
  }
}

async function requireRepo(folder: string) {
  const repo = await resolveRepo(folder);
  if (!repo) {
    throw new Error("This folder is not a git repository.");
  }
  return repo;
}

const folderInput = z.object({ path: z.string().min(1) });

/** Returns null when the folder is not inside a git repository. */
export const resolve = os
  .input(folderInput)
  .output(repoInfoSchema.nullable())
  .handler(({ input }) => resolveRepo(input.path));

export const init = os
  .input(folderInput)
  .output(repoInfoSchema.nullable())
  .handler(({ input }) => expose(() => initRepo(input.path)));

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

export const create = os
  .input(
    z.object({
      name: z.string().min(1),
      path: z.string().min(1),
      startPoint: z.string().min(1),
    })
  )
  .output(z.object({ worktreePath: z.string() }))
  .handler(({ input }) =>
    expose(async () => {
      const repo = await requireRepo(input.path);
      const worktreePath = await createWorktree(repo, {
        name: input.name,
        startPoint: input.startPoint,
      });
      await refresh(repo.root);
      return { worktreePath };
    })
  );

export const status = os
  .input(
    z.object({
      branch: z.string().nullable(),
      parentBranch: z.string().nullable(),
      path: z.string().min(1),
      worktreePath: z.string().min(1),
    })
  )
  .output(worktreeStatusSchema)
  .handler(async ({ input }) => {
    const repo = await requireRepo(input.path);
    return await worktreeStatus(repo, {
      branch: input.branch,
      parentBranch: input.parentBranch,
      worktreePath: input.worktreePath,
    });
  });

const diffInput = z.object({
  parentBranch: z.string().nullable(),
  path: z.string().min(1),
  worktreePath: z.string().min(1),
});

/** The full parsed diff for the Diff tab — merge-base to worktree. */
export const diff = os
  .input(diffInput)
  .output(worktreeDiffSchema)
  .handler(({ input }) =>
    expose(async () => {
      const repo = await requireRepo(input.path);
      return await worktreeDiff(repo, {
        parentBranch: input.parentBranch,
        worktreePath: input.worktreePath,
      });
    })
  );

/** Path-level statuses for the file tree's badges. */
export const changedPaths = os
  .input(diffInput)
  .output(z.array(changedPathSchema))
  .handler(({ input }) =>
    expose(async () => {
      const repo = await requireRepo(input.path);
      return await worktreeChangedPaths(repo, {
        parentBranch: input.parentBranch,
        worktreePath: input.worktreePath,
      });
    })
  );

/** Numstat totals for the Agent tab's compact strip. */
export const diffSummary = os
  .input(diffInput)
  .output(diffSummarySchema)
  .handler(({ input }) =>
    expose(async () => {
      const repo = await requireRepo(input.path);
      return await worktreeDiffSummary(repo, {
        parentBranch: input.parentBranch,
        worktreePath: input.worktreePath,
      });
    })
  );

export const remove = os
  .input(
    z.object({
      branch: z.string().nullable(),
      deleteBranch: z.boolean(),
      force: z.boolean(),
      path: z.string().min(1),
      worktreePath: z.string().min(1),
    })
  )
  .output(z.object({ ok: z.literal(true) }))
  .handler(({ input }) =>
    expose(async () => {
      const repo = await requireRepo(input.path);

      await removeWorktree(repo, {
        force: input.force,
        worktreePath: input.worktreePath,
      });

      if (input.deleteBranch && input.branch) {
        // The worktree is already gone; -D is the only option left for a branch
        // that is not contained in its parent, and the caller has confirmed it.
        await deleteBranch(repo, { branch: input.branch, force: true });
      }

      await refresh(repo.root);
      return { ok: true as const };
    })
  );

export const prune = os
  .input(folderInput)
  .output(z.object({ ok: z.literal(true) }))
  .handler(({ input }) =>
    expose(async () => {
      const repo = await requireRepo(input.path);
      await pruneWorktrees(repo);
      await refresh(repo.root);
      return { ok: true as const };
    })
  );

export const rename = os
  .input(
    z.object({
      from: z.string().min(1),
      path: z.string().min(1),
      to: z.string().min(1),
    })
  )
  .output(z.object({ branch: z.string() }))
  .handler(({ input }) =>
    expose(async () => {
      const repo = await requireRepo(input.path);
      const branch = await renameBranch(repo, {
        from: input.from,
        to: input.to,
      });
      await refresh(repo.root);
      return { branch };
    })
  );
