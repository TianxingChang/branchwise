import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { resolveRepo } from "@/ipc/repo/repo";
import { RepoWatcher } from "@/ipc/repo/watcher";
import type { RepoSnapshot } from "@/types/branch";

const run = promisify(execFile);

const GIT_ENV = [
  "-c",
  "user.email=test@branchwise.local",
  "-c",
  "user.name=branchwise test",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "init.defaultBranch=main",
];

async function git(cwd: string, ...args: string[]) {
  await run("git", [...GIT_ENV, ...args], { cwd });
}

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    // Teardown must be ordered: the watcher stops before its repo is deleted.
    // biome-ignore lint/performance/noAwaitInLoops: see above
    await cleanup();
  }
});

async function fixture() {
  const workspace = await mkdtemp(path.join(tmpdir(), "branchwise-watch-"));
  cleanups.push(() => rm(workspace, { force: true, recursive: true }));

  const repoPath = path.join(workspace, "repo");
  await run("git", [...GIT_ENV, "init", repoPath]);
  await git(repoPath, "commit", "--allow-empty", "-m", "init");

  const repo = await resolveRepo(repoPath);
  if (!repo) {
    throw new Error("fixture repository did not resolve");
  }

  const watcher = new RepoWatcher(repo);
  await watcher.start();
  cleanups.push(() => watcher.stop());

  const seen: RepoSnapshot[] = [];
  const controller = new AbortController();

  const pump = (async () => {
    for await (const snapshot of watcher.follow(controller.signal)) {
      seen.push(snapshot);
    }
  })();

  // Registered before the abort so teardown, which runs in reverse, aborts
  // first and only then waits for the pump to finish.
  cleanups.push(() => pump);
  cleanups.push(() => controller.abort());

  return { controller, repo, seen, watcher, workspace };
}

/** Waits for a condition the watcher is expected to reach on its own. */
async function eventually(
  predicate: () => boolean,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    // Polling loop: each wait must finish before the next check.
    // biome-ignore lint/performance/noAwaitInLoops: see above
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition was never reached");
}

describe("RepoWatcher", () => {
  test("publishes an initial snapshot on subscribe", async () => {
    const { repo, seen } = await fixture();

    await eventually(() => seen.length > 0);

    expect(seen[0].worktrees).toHaveLength(1);
    expect(seen[0].worktrees[0].path).toBe(repo.root);
  }, 30_000);

  test("picks up a worktree created outside branchwise", async () => {
    const { repo, seen, workspace } = await fixture();
    await eventually(() => seen.length > 0);

    // Exactly what an agent shelling out to git would do.
    await git(
      repo.root,
      "worktree",
      "add",
      "-b",
      "feat/from-agent",
      path.join(workspace, "wt-agent"),
      "main"
    );

    await eventually(() =>
      Boolean(
        seen
          .at(-1)
          ?.worktrees.some((entry) => entry.branch === "feat/from-agent")
      )
    );

    const latest = seen.at(-1) as RepoSnapshot;
    expect(latest.origins["feat/from-agent"]).toBe("main");
  }, 30_000);

  test("picks up a worktree removed outside branchwise", async () => {
    const { repo, seen, workspace } = await fixture();
    const target = path.join(workspace, "wt-doomed");

    await git(
      repo.root,
      "worktree",
      "add",
      "-b",
      "feat/doomed",
      target,
      "main"
    );
    // Assert on the *latest* snapshot: the initial one also had a single
    // worktree, so "some snapshot had one" would pass without waiting.
    await eventually(() => seen.at(-1)?.worktrees.length === 2);

    await git(repo.root, "worktree", "remove", target);

    await eventually(() => seen.at(-1)?.worktrees.length === 1);

    expect((seen.at(-1) as RepoSnapshot).worktrees).toHaveLength(1);
  }, 30_000);

  test("does not republish when nothing changed", async () => {
    const { seen, watcher } = await fixture();
    await eventually(() => seen.length > 0);

    const before = seen.length;
    await watcher.poke();
    await watcher.poke();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(seen.length).toBe(before);
  }, 30_000);

  test("stops publishing once the subscriber aborts", async () => {
    const { controller, repo, seen, workspace } = await fixture();
    await eventually(() => seen.length > 0);

    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const frozen = seen.length;

    await git(
      repo.root,
      "worktree",
      "add",
      "-b",
      "feat/after-abort",
      path.join(workspace, "wt-after"),
      "main"
    );
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(seen.length).toBe(frozen);
  }, 30_000);
});
