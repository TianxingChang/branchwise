import path from "node:path";
import { findExecutable } from "@/ipc/agent/find-executable";

const DEFAULT_SYSTEM_CANDIDATES = [
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
];

export function resolveCodexExecutable(
  env: NodeJS.ProcessEnv = process.env,
  systemCandidates: string[] = DEFAULT_SYSTEM_CANDIDATES
): Promise<string | null> {
  const home = env.HOME ?? "";
  return findExecutable({
    binaryName: "codex",
    env,
    envOverride: env.CODEX_BIN,
    extraCandidates: [
      ...(home ? [path.join(home, ".local", "bin", "codex")] : []),
      ...systemCandidates,
    ],
  });
}
