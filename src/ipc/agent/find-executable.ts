import { access, constants } from "node:fs/promises";
import path from "node:path";

async function executable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds a user-installed CLI. branchwise never bundles a runtime and never
 * stores credentials: the user's install carries their subscription
 * (decision 2). A Finder-launched Electron has a minimal PATH, so callers
 * pass well-known install locations to check before PATH.
 */
export async function findExecutable(input: {
  binaryName: string;
  env: NodeJS.ProcessEnv;
  envOverride?: string;
  extraCandidates: string[];
}): Promise<string | null> {
  const candidates = [input.envOverride, ...input.extraCandidates];
  for (const candidate of candidates) {
    if (
      candidate &&
      path.isAbsolute(candidate) &&
      // biome-ignore lint/performance/noAwaitInLoops: we return on first match
      (await executable(candidate))
    ) {
      return candidate;
    }
  }

  for (const dir of (input.env.PATH ?? "").split(path.delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    const candidate = path.join(dir, input.binaryName);
    if (
      path.isAbsolute(candidate) &&
      // biome-ignore lint/performance/noAwaitInLoops: we return on first match
      (await executable(candidate))
    ) {
      return candidate;
    }
  }
  return null;
}
