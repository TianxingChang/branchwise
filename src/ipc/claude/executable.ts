import path from "node:path";
import { findExecutable } from "@/ipc/agent/find-executable";

const DEFAULT_SYSTEM_CANDIDATES = [
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
];

export function resolveClaudeExecutable(
  env: NodeJS.ProcessEnv = process.env,
  // Injectable so tests never depend on what is really installed at the
  // fixed system paths on the machine running them.
  systemCandidates: string[] = DEFAULT_SYSTEM_CANDIDATES
): Promise<string | null> {
  const home = env.HOME ?? "";
  return findExecutable({
    binaryName: "claude",
    env,
    envOverride: env.CLAUDE_BIN,
    extraCandidates: [
      ...(home
        ? [
            path.join(home, ".local", "bin", "claude"),
            path.join(home, ".claude", "local", "claude"),
          ]
        : []),
      ...systemCandidates,
    ],
  });
}
