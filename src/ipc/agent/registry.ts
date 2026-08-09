import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { agentDriverIdSchema, permissionTierSchema } from "@/types/agent";

const worktreeAgentStateSchema = z.object({
  driverId: agentDriverIdSchema,
  sessionId: z.string().nullable(),
  threadId: z.string().nullable(),
  tier: permissionTierSchema,
  updatedAt: z.number(),
});
export type WorktreeAgentState = z.infer<typeof worktreeAgentStateSchema>;

export const agentRegistrySchema = z.object({
  lastDriverId: agentDriverIdSchema,
  version: z.literal(1),
  worktrees: z.record(z.string(), worktreeAgentStateSchema),
});
export type AgentRegistry = z.infer<typeof agentRegistrySchema>;

function emptyRegistry(): AgentRegistry {
  return { lastDriverId: "claude-code", version: 1, worktrees: {} };
}

function registryFile(baseDir: string): string {
  return path.join(baseDir, "registry.json");
}

/**
 * Loading never throws and never writes: an unreadable registry is treated as
 * empty in memory, but the bytes on disk stay untouched until the next save.
 */
export async function loadRegistry(baseDir: string): Promise<AgentRegistry> {
  try {
    const raw = await readFile(registryFile(baseDir), "utf8");
    return agentRegistrySchema.parse(JSON.parse(raw));
  } catch {
    return emptyRegistry();
  }
}

/** Atomic write: temp file then rename, so a crash never leaves half a file. */
export async function saveRegistry(
  baseDir: string,
  registry: AgentRegistry
): Promise<void> {
  await mkdir(baseDir, { recursive: true });
  const file = registryFile(baseDir);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(registry, null, 2), "utf8");
  await rename(tmp, file);
}
