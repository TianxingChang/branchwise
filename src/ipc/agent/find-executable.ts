import { access, constants } from "node:fs/promises";
import path from "node:path";
import { loginShellPath } from "@/ipc/agent/login-path";

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
 *
 * Those locations are a guess, and the guess runs out: a CLI installed under
 * a node version manager's own prefix is in none of them. So the last resort
 * is to ask the user's login shell what PATH it would have — the same answer
 * they would get by typing `which` in a terminal, which is the thing they
 * will compare against when they report it as broken.
 */
export async function findExecutable(input: {
  binaryName: string;
  env: NodeJS.ProcessEnv;
  envOverride?: string;
  extraCandidates: string[];
  /** Injected by tests; production asks the login shell, once, and caches. */
  fallbackPath?: () => Promise<string[]>;
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

  const onPath = await search(
    (input.env.PATH ?? "").split(path.delimiter),
    input.binaryName
  );
  if (onPath) {
    return onPath;
  }

  const fallback = input.fallbackPath ?? loginShellPath;
  return search(await fallback(), input.binaryName);
}

async function search(
  dirs: string[],
  binaryName: string
): Promise<string | null> {
  for (const dir of dirs) {
    if (dir.length === 0) {
      continue;
    }
    const candidate = path.join(dir, binaryName);
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
