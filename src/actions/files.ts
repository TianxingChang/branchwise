import { ipc } from "@/ipc/manager";
import type { FileChange, FileContent, WorktreeTree } from "@/types/files";

export function readTextFile(
  worktreePath: string,
  relativePath: string
): Promise<FileContent> {
  return ipc.client.files.read({ path: relativePath, worktreePath });
}

/** Every path in the worktree, which is what the tree model wants up front. */
export function readWorktreeTree(worktreePath: string): Promise<WorktreeTree> {
  return ipc.client.files.tree({ worktreePath });
}

export function watchFiles(
  worktreePath: string,
  signal: AbortSignal
): Promise<AsyncIterable<FileChange>> {
  return ipc.client.files.watch({ worktreePath }, { signal });
}
