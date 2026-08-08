import path from "node:path";
import { normalizeBranchName, slugForBranch } from "@/lib/git/naming";
import type { RepoInfo, WorktreeStatus } from "@/types/branch";
import { runGit, tryGit } from "./command";

export class WorktreeOperationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorktreeOperationError";
  }
}

async function branchExists(repo: RepoInfo, branch: string): Promise<boolean> {
  const found = await tryGit(
    repo.root,
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { queueKey: repo.root }
  );
  return found !== null;
}

/**
 * Creates a branch and a worktree for it in one step.
 *
 * The child starts from the start point's committed tip — uncommitted work in
 * the parent's worktree does not come along, which is why the caller warns
 * about it before getting here.
 */
export async function createWorktree(
  repo: RepoInfo,
  input: { name: string; startPoint: string }
): Promise<string> {
  if (repo.isEmpty) {
    throw new WorktreeOperationError(
      "This repository has no commits yet. Make the first commit before branching."
    );
  }

  const name = normalizeBranchName(input.name);
  if (name.length === 0) {
    throw new WorktreeOperationError("Enter a branch name.");
  }
  if (await branchExists(repo, name)) {
    throw new WorktreeOperationError(
      `A branch named "${name}" already exists.`
    );
  }

  const target = path.join(repo.worktreeRoot, slugForBranch(name));

  try {
    await runGit(
      repo.root,
      ["worktree", "add", "-b", name, target, input.startPoint],
      { queueKey: repo.root }
    );
  } catch (error) {
    throw new WorktreeOperationError(
      error instanceof Error ? error.message : "Could not create the worktree.",
      { cause: error }
    );
  }

  return target;
}

export async function removeWorktree(
  repo: RepoInfo,
  input: { force: boolean; worktreePath: string }
): Promise<void> {
  const args = ["worktree", "remove"];
  if (input.force) {
    args.push("--force");
  }
  args.push(input.worktreePath);

  try {
    await runGit(repo.root, args, { queueKey: repo.root });
  } catch (error) {
    throw new WorktreeOperationError(
      error instanceof Error ? error.message : "Could not remove the worktree.",
      { cause: error }
    );
  }
}

export async function deleteBranch(
  repo: RepoInfo,
  input: { branch: string; force: boolean }
): Promise<void> {
  try {
    await runGit(
      repo.root,
      ["branch", input.force ? "-D" : "-d", input.branch],
      { queueKey: repo.root }
    );
  } catch (error) {
    throw new WorktreeOperationError(
      error instanceof Error ? error.message : "Could not delete the branch.",
      { cause: error }
    );
  }
}

/**
 * The facts the delete confirmation needs: how much uncommitted work would be
 * thrown away, and whether the branch is already contained in its parent.
 */
export async function worktreeStatus(
  repo: RepoInfo,
  input: {
    branch: string | null;
    parentBranch: string | null;
    worktreePath: string;
  }
): Promise<WorktreeStatus> {
  const porcelain = await tryGit(
    input.worktreePath,
    ["status", "--porcelain"],
    {
      queueKey: repo.root,
    }
  );

  const dirtyCount =
    porcelain === null
      ? 0
      : porcelain.split("\n").filter((line) => line.trim().length > 0).length;

  let merged = false;
  if (input.branch && input.parentBranch) {
    const ancestor = await tryGit(
      repo.root,
      ["merge-base", "--is-ancestor", input.branch, input.parentBranch],
      { queueKey: repo.root }
    );
    merged = ancestor !== null;
  }

  return { dirtyCount, merged };
}

export async function pruneWorktrees(repo: RepoInfo): Promise<void> {
  await runGit(repo.root, ["worktree", "prune"], { queueKey: repo.root });
}
