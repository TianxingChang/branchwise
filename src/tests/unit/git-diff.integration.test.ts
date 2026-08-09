import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { worktreeDiff, worktreeDiffSummary } from "@/ipc/repo/diff";
import { resolveRepo } from "@/ipc/repo/repo";
import type { RepoInfo } from "@/types/branch";

const run = promisify(execFile);

const SHA_40 = /^[0-9a-f]{40}$/;

/**
 * Real git, because the semantics under test are git's: that a diff against
 * the merge-base folds committed and uncommitted work into one view, and that
 * the parent moving ahead does not leak its commits into the child's diff.
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
let wt: string;
let repo: RepoInfo;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "branchwise-diff-"));
  repoPath = path.join(workspace, "repo");
  wt = path.join(workspace, "wt-x");

  await run("git", [...GIT_ENV, "init", repoPath]);
  await writeFile(path.join(repoPath, "base.txt"), "one\ntwo\n");
  await writeFile(path.join(repoPath, "keep.txt"), "keep\n");
  await writeFile(path.join(repoPath, "mover.txt"), "moving content\n");
  await git(repoPath, "add", ".");
  await git(repoPath, "commit", "-m", "init");

  await git(repoPath, "worktree", "add", "-b", "feat/x", wt, "main");

  // Committed work on the branch: edit one file, rename another.
  await writeFile(path.join(wt, "base.txt"), "one\nTWO\n");
  await git(wt, "mv", "mover.txt", "moved.txt");
  await git(wt, "add", "base.txt");
  await git(wt, "commit", "-m", "branch work");

  // Uncommitted work: an edit to a tracked file and a brand-new file.
  await writeFile(path.join(wt, "keep.txt"), "keep\nmore\n");
  await writeFile(path.join(wt, "fresh.txt"), "untracked\n");

  // The parent moves on — its new file must NOT appear in the child's diff.
  await writeFile(path.join(repoPath, "parent-only.txt"), "parent\n");
  await git(repoPath, "add", "parent-only.txt");
  await git(repoPath, "commit", "-m", "parent advanced");

  const resolved = await resolveRepo(repoPath);
  if (!resolved) {
    throw new Error("test repo did not resolve");
  }
  repo = resolved;
});

afterAll(async () => {
  await rm(workspace, { force: true, recursive: true });
});

describe("worktreeDiff", () => {
  test("folds committed and uncommitted changes into one file list", async () => {
    const diff = await worktreeDiff(repo, {
      parentBranch: "main",
      worktreePath: wt,
    });
    const paths = diff.files.map((file) => file.path);

    expect(paths).toContain("base.txt");
    expect(paths).toContain("keep.txt");
  });

  test("anchors at the merge-base, not the parent's tip", async () => {
    const diff = await worktreeDiff(repo, {
      parentBranch: "main",
      worktreePath: wt,
    });

    expect(diff.files.map((file) => file.path)).not.toContain(
      "parent-only.txt"
    );
    expect(diff.baseRef).toMatch(SHA_40);
  });

  test("marks only the files with uncommitted changes dirty", async () => {
    const diff = await worktreeDiff(repo, {
      parentBranch: "main",
      worktreePath: wt,
    });
    const byPath = new Map(diff.files.map((file) => [file.path, file]));

    expect(byPath.get("keep.txt")?.dirty).toBe(true);
    expect(byPath.get("base.txt")?.dirty).toBe(false);
  });

  test("detects the rename", async () => {
    const diff = await worktreeDiff(repo, {
      parentBranch: "main",
      worktreePath: wt,
    });
    const moved = diff.files.find((file) => file.path === "moved.txt");

    expect(moved?.kind).toBe("renamed");
    expect(moved?.oldPath).toBe("mover.txt");
  });

  test("lists an untracked file by name instead of dropping it", async () => {
    const diff = await worktreeDiff(repo, {
      parentBranch: "main",
      worktreePath: wt,
    });

    expect(diff.untracked).toContain("fresh.txt");
    expect(diff.files.map((file) => file.path)).not.toContain("fresh.txt");
  });

  test("falls back to HEAD for a node with no parent", async () => {
    await writeFile(path.join(repoPath, "root-edit.txt"), "parent\nedited\n");
    await git(repoPath, "add", "root-edit.txt");
    await git(repoPath, "commit", "-m", "add root-edit");
    await writeFile(path.join(repoPath, "root-edit.txt"), "parent\nEDITED\n");

    const diff = await worktreeDiff(repo, {
      parentBranch: null,
      worktreePath: repoPath,
    });

    expect(diff.baseRef).toBe("HEAD");
    expect(diff.files.map((file) => file.path)).toContain("root-edit.txt");
  });
});

describe("worktreeDiffSummary", () => {
  test("counts files and added/deleted lines", async () => {
    const summary = await worktreeDiffSummary(repo, {
      parentBranch: "main",
      worktreePath: wt,
    });

    // base.txt: +1/−1, keep.txt: +1, moved.txt: rename with no line changes.
    expect(summary.files).toBe(3);
    expect(summary.additions).toBe(2);
    expect(summary.deletions).toBe(1);
  });
});
