import { ipc } from "@/ipc/manager";
import type { RepoInfo, RepoSnapshot } from "@/types/branch";

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
