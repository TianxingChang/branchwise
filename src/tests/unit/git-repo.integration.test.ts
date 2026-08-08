import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { branchOrigin, listWorktrees, resolveRepo } from "@/ipc/repo/repo";
import { resolveNodeTree } from "@/lib/git/resolve";
import type { RepoInfo } from "@/types/branch";

const run = promisify(execFile);

/**
 * These tests drive real git rather than fixtures. The premises this feature
 * rests on — that a reflog records `Created from <ref>`, and that an implicit
 * start point records only `HEAD` — are git behaviours, and only real git can
 * confirm they still hold.
 */
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

let workspace: string;
let repoPath: string;
let repo: RepoInfo;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "branchwise-git-"));
  repoPath = path.join(workspace, "repo");

  await run("git", [...GIT_ENV, "init", repoPath]);
  await git(repoPath, "commit", "--allow-empty", "-m", "init");

  // Explicit start point: git records the parent by name.
  await git(
    repoPath,
    "worktree",
    "add",
    "-b",
    "feat/a",
    path.join(workspace, "wt-a"),
    "main"
  );
  await git(
    path.join(workspace, "wt-a"),
    "commit",
    "--allow-empty",
    "-m",
    "a1"
  );

  // Child of a child, again with an explicit start point.
  await git(
    repoPath,
    "worktree",
    "add",
    "-b",
    "feat/b",
    path.join(workspace, "wt-b"),
    "feat/a"
  );

  // Implicit start point: git records only "HEAD".
  await git(
    repoPath,
    "worktree",
    "add",
    "-b",
    "feat/implicit",
    path.join(workspace, "wt-implicit")
  );

  const resolved = await resolveRepo(repoPath);
  if (!resolved) {
    throw new Error("fixture repository did not resolve");
  }
  repo = resolved;
}, 60_000);

afterAll(async () => {
  if (workspace) {
    await rm(workspace, { force: true, recursive: true });
  }
});

describe("resolveRepo", () => {
  test("returns null outside a repository", async () => {
    const plain = await mkdtemp(path.join(tmpdir(), "branchwise-plain-"));
    try {
      expect(await resolveRepo(plain)).toBeNull();
    } finally {
      await rm(plain, { force: true, recursive: true });
    }
  });

  test("reports the main worktree as the root", async () => {
    expect(repo.root).toBe(await realpath(repoPath));
    expect(repo.headBranch).toBe("main");
    expect(repo.isEmpty).toBe(false);
  });

  test("derives the sibling worktree root", () => {
    expect(repo.worktreeRoot).toBe(`${repo.root}.worktrees`);
  });

  test("normalizes a linked worktree back to the main repository", async () => {
    const fromLinked = await resolveRepo(path.join(workspace, "wt-a"));

    expect(fromLinked?.root).toBe(repo.root);
    expect(fromLinked?.commonDir).toBe(repo.commonDir);
  });

  test("recognises a repository with no commits yet", async () => {
    const empty = path.join(workspace, "empty");
    await run("git", [...GIT_ENV, "init", empty]);
    const resolved = await resolveRepo(empty);

    expect(resolved?.isEmpty).toBe(true);
  });
});

describe("listWorktrees", () => {
  test("returns every worktree with its branch", async () => {
    const entries = await listWorktrees(repo.root);
    const branches = entries.map((entry) => entry.branch).sort();

    expect(branches).toEqual(["feat/a", "feat/b", "feat/implicit", "main"]);
  });

  test("lists the main worktree first", async () => {
    const entries = await listWorktrees(repo.root);

    expect(entries[0].path).toBe(repo.root);
  });
});

describe("branchOrigin", () => {
  test("recovers a named start point", async () => {
    expect(await branchOrigin(repo, "feat/a")).toBe("main");
  });

  test("recovers a chained start point", async () => {
    expect(await branchOrigin(repo, "feat/b")).toBe("feat/a");
  });

  test("falls back to a containing branch when git only recorded HEAD", async () => {
    // `worktree add -b` with no start point writes "Created from HEAD"; the
    // parent has to be recovered from the commit it started at.
    expect(await branchOrigin(repo, "feat/implicit")).toBe("main");
  });

  test("returns null for a branch that does not exist", async () => {
    expect(await branchOrigin(repo, "no-such-branch")).toBeNull();
  });
});

describe("end to end: real git to canvas tree", () => {
  test("builds the tree the worktrees actually describe", async () => {
    const worktrees = await listWorktrees(repo.root);

    const origins: Record<string, string | null> = {};
    for (const entry of worktrees) {
      if (entry.branch) {
        // Serial on purpose — mirrors how the watcher reads provenance.
        // biome-ignore lint/performance/noAwaitInLoops: see above
        origins[entry.branch] = await branchOrigin(repo, entry.branch);
      }
    }

    const { nodes } = resolveNodeTree({
      annotations: {},
      mainWorktreePath: repo.root,
      origins,
      worktrees,
    });

    const byBranch = new Map(nodes.map((node) => [node.branch, node]));
    const root = byBranch.get("main");
    const a = byBranch.get("feat/a");
    const b = byBranch.get("feat/b");
    const implicit = byBranch.get("feat/implicit");

    expect(root?.isRoot).toBe(true);
    expect(root?.parentId).toBeNull();
    expect(a?.parentId).toBe(root?.id);
    expect(b?.parentId).toBe(a?.id);
    expect(implicit?.parentId).toBe(root?.id);
  });

  test("a worktree removed outside branchwise leaves the tree", async () => {
    const throwaway = path.join(workspace, "wt-temp");
    await git(
      repo.root,
      "worktree",
      "add",
      "-b",
      "feat/temp",
      throwaway,
      "main"
    );

    const withTemp = await listWorktrees(repo.root);
    expect(withTemp.map((entry) => entry.branch)).toContain("feat/temp");

    await git(repo.root, "worktree", "remove", throwaway);

    const withoutTemp = await listWorktrees(repo.root);
    expect(withoutTemp.map((entry) => entry.branch)).not.toContain("feat/temp");
  }, 30_000);
});

/** macOS puts temp dirs behind /private, which git reports resolved. */
async function realpath(target: string): Promise<string> {
  const { stdout } = await run("realpath", [target]).catch(async () => ({
    stdout: target,
  }));
  return stdout.trim();
}
