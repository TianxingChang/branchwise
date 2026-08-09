import { sanitizedEnvironment as sharedSanitizedEnvironment } from "@/ipc/agent/env";
import type { PermissionTier } from "@/types/agent";

const TIER_TO_MODE: Record<PermissionTier, string> = {
  "accept-edits": "acceptEdits",
  ask: "default",
  plan: "plan",
  yolo: "bypassPermissions",
};

/**
 * Delegates to the shared implementation in @/ipc/agent/env (also used by
 * the codex spawn, so both vendors strip the exact same git redirection
 * variables). Kept as a real exported function here, not a re-export: this
 * module's existing consumers and tests import `sanitizedEnvironment` from
 * `@/ipc/claude/options` and keep working unchanged.
 */
export function sanitizedEnvironment(
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return sharedSanitizedEnvironment(env);
}

export type CanUseToolShim = (
  toolName: string,
  toolInput: Record<string, unknown>,
  options: { signal: AbortSignal }
) => Promise<
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string }
>;

/**
 * Pure so the spawn contract is unit-testable: cwd, env, permission mode and
 * the resume id are decided here and nowhere else.
 */
export function buildClaudeOptions(input: {
  abortController: AbortController;
  canUseTool: CanUseToolShim;
  executable: string;
  resumeSessionId: string | null;
  tier: PermissionTier;
  worktreePath: string;
}): Record<string, unknown> {
  return {
    abortController: input.abortController,
    canUseTool: input.canUseTool,
    cwd: input.worktreePath,
    env: sanitizedEnvironment(),
    includePartialMessages: true,
    pathToClaudeCodeExecutable: input.executable,
    permissionMode: TIER_TO_MODE[input.tier],
    ...(input.tier === "yolo" ? { allowDangerouslySkipPermissions: true } : {}),
    ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
  };
}
