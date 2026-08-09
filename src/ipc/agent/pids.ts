import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function pidFile(baseDir: string): string {
  return path.join(baseDir, "pids.json");
}

async function write(baseDir: string, pids: number[]): Promise<void> {
  await mkdir(baseDir, { recursive: true });
  const file = pidFile(baseDir);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(pids), "utf8");
  await rename(tmp, file);
}

export async function listPids(baseDir: string): Promise<number[]> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(pidFile(baseDir), "utf8")
    );
    return Array.isArray(parsed)
      ? parsed.filter((pid): pid is number => typeof pid === "number")
      : [];
  } catch {
    return [];
  }
}

export async function registerPid(baseDir: string, pid: number): Promise<void> {
  const pids = await listPids(baseDir);
  if (!pids.includes(pid)) {
    pids.push(pid);
  }
  await write(baseDir, pids);
}

export async function unregisterPid(
  baseDir: string,
  pid: number
): Promise<void> {
  await write(
    baseDir,
    (await listPids(baseDir)).filter((entry) => entry !== pid)
  );
}

/**
 * Kills anything from a previous run that is still alive — the only cleanup
 * that survives a hard crash (atlas A3). Returns the pids it killed.
 */
export async function reapStrays(baseDir: string): Promise<number[]> {
  const killed: number[] = [];
  for (const pid of await listPids(baseDir)) {
    try {
      process.kill(pid, 0);
    } catch {
      continue; // already gone
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        continue;
      }
    }
    killed.push(pid);
  }
  await write(baseDir, []);
  return killed;
}
