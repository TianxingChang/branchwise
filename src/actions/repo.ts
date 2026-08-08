import { ipc } from "@/ipc/manager";
import type { RepoInfo, RepoSnapshot, WorktreeStatus } from "@/types/branch";

export function resolveRepo(path: string): Promise<RepoInfo | null> {
  return ipc.client.repo.resolve({ path });
}

export function initRepo(path: string): Promise<RepoInfo | null> {
  return ipc.client.repo.init({ path });
}

/**
 * Subscribes to the repository. Yields a full snapshot immediately and again
 * whenever git changes underneath, until the signal aborts.
 */
export function watchRepo(
  path: string,
  signal: AbortSignal
): Promise<AsyncIterable<RepoSnapshot>> {
  return ipc.client.repo.watch({ path }, { signal });
}

export function createWorktree(input: {
  name: string;
  path: string;
  startPoint: string;
}): Promise<{ worktreePath: string }> {
  return ipc.client.repo.create(input);
}

export function worktreeStatus(input: {
  branch: string | null;
  parentBranch: string | null;
  path: string;
  worktreePath: string;
}): Promise<WorktreeStatus> {
  return ipc.client.repo.status(input);
}

export function removeWorktree(input: {
  branch: string | null;
  deleteBranch: boolean;
  force: boolean;
  path: string;
  worktreePath: string;
}): Promise<{ ok: true }> {
  return ipc.client.repo.remove(input);
}

export function pruneWorktrees(path: string): Promise<{ ok: true }> {
  return ipc.client.repo.prune({ path });
}

export function renameBranch(input: {
  from: string;
  path: string;
  to: string;
}): Promise<{ branch: string }> {
  return ipc.client.repo.rename(input);
}
