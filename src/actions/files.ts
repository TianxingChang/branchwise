import { ipc } from "@/ipc/manager";
import type { DirectoryListing, FileContent } from "@/types/files";

export function listDirectory(
  worktreePath: string,
  relativePath: string
): Promise<DirectoryListing> {
  return ipc.client.files.list({ path: relativePath, worktreePath });
}

export function readTextFile(
  worktreePath: string,
  relativePath: string
): Promise<FileContent> {
  return ipc.client.files.read({ path: relativePath, worktreePath });
}
