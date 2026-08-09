import type { PermissionTier } from "@/types/agent";

const STRIPPED_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
];

/**
 * The inherited environment minus git redirection. A GIT_DIR leaking in from
 * whatever spawned branchwise would make every agent operate on the wrong
 * repository regardless of cwd — the A2 correctness bug in env form.
 */
export function sanitizedEnvironment(
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const key of STRIPPED_ENV) {
    delete clean[key];
  }
  return clean;
}

const TIER_TO_MODE: Record<PermissionTier, string> = {
  "accept-edits": "acceptEdits",
  ask: "default",
  plan: "plan",
  yolo: "bypassPermissions",
};

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
