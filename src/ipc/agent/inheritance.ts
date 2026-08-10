import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { worktreeHash } from "./transcript";

export interface PendingInheritance {
  brief?: string;
  history?: { role: "assistant" | "user"; text: string }[];
  mode: "brief" | "full";
  note: string;
  parentSessionId?: string;
  parentWorktree: string;
}

const pendingInheritanceSchema = z.object({
  brief: z.string().optional(),
  history: z
    .array(
      z.object({
        role: z.enum(["assistant", "user"]),
        text: z.string(),
      })
    )
    .optional(),
  mode: z.enum(["brief", "full"]),
  note: z.string(),
  parentSessionId: z.string().optional(),
  parentWorktree: z.string(),
});

function inheritanceFile(baseDir: string, childWorktree: string): string {
  return path.join(
    baseDir,
    "inherited",
    `inherit-${worktreeHash(childWorktree)}.json`
  );
}

/**
 * Writes a pending inheritance payload atomically beside the transcripts.
 * Uses temp file then rename, so a crash never leaves half a file.
 */
export async function writePendingInheritance(
  baseDir: string,
  childWorktree: string,
  pending: PendingInheritance
): Promise<void> {
  await mkdir(path.dirname(inheritanceFile(baseDir, childWorktree)), {
    recursive: true,
  });
  const file = inheritanceFile(baseDir, childWorktree);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(pending, null, 2), "utf8");
  await rename(tmp, file);
}

/**
 * Reads a pending inheritance payload. Returns null if the file is missing
 * or unparseable (leaving bytes untouched on disk for a torn/corrupt file).
 */
export async function readPendingInheritance(
  baseDir: string,
  childWorktree: string
): Promise<PendingInheritance | null> {
  try {
    const raw = await readFile(inheritanceFile(baseDir, childWorktree), "utf8");
    return pendingInheritanceSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Clears a pending inheritance (idempotent, does not throw if missing).
 */
export async function clearPendingInheritance(
  baseDir: string,
  childWorktree: string
): Promise<void> {
  try {
    await rm(inheritanceFile(baseDir, childWorktree), { force: true });
  } catch {
    // Idempotent: missing files are not an error.
  }
}
