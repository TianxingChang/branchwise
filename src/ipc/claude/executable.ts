import path from "node:path";
import { findExecutable } from "@/ipc/agent/find-executable";

export function resolveClaudeExecutable(
  env: NodeJS.ProcessEnv = process.env
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
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ],
  });
}
