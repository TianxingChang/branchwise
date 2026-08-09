import { parseUnifiedDiff } from "@/lib/git/diff-parse";
import type { RepoInfo } from "@/types/branch";
import type { ChangedPath, DiffSummary, WorktreeDiff } from "@/types/diff";
import { runGit, tryGit } from "./command";

interface DiffInput {
  parentBranch: string | null;
  worktreePath: string;
}

/**
 * Flags that keep a read of an untrusted repository from executing anything:
 * external diff drivers and textconv filters both name arbitrary commands in
 * repo-controlled config.
 */
const SAFE_DIFF = ["--no-color", "--no-ext-diff", "--no-textconv", "-M"];

/**
 * The ref this node's work is measured against: the merge-base with its
 * parent, so the parent moving ahead never leaks into the child's diff. A
 * node with no parent measures its worktree against its own HEAD — and a
 * repository with no commits yet has no HEAD to resolve, so it measures
 * against the empty tree instead: everything staged reads as added.
 */
async function resolveBase(repo: RepoInfo, input: DiffInput): Promise<string> {
  if (input.parentBranch) {
    const base = await tryGit(
      input.worktreePath,
      ["merge-base", input.parentBranch, "HEAD"],
      { queueKey: repo.root }
    );
    if (base?.trim()) {
      return base.trim();
    }
  }

  const head = await tryGit(
    input.worktreePath,
    ["rev-parse", "--verify", "HEAD"],
    { queueKey: repo.root }
  );
  if (head) {
    return "HEAD";
  }

  // Asking git for the id keeps this correct under sha256 repositories,
  // where the well-known sha1 empty-tree constant would be wrong.
  const emptyTree = await tryGit(
    input.worktreePath,
    ["hash-object", "-t", "tree", "/dev/null"],
    { queueKey: repo.root }
  );
  return emptyTree?.trim() || "HEAD";
}

/**
 * Everything this branch would land, as one parsed diff: committed work and
 * uncommitted edits fold together because the comparison runs from the
 * merge-base straight to the worktree. Untracked files cannot appear in
 * `git diff`, so they are listed by name alongside.
 */
export async function worktreeDiff(
  repo: RepoInfo,
  input: DiffInput
): Promise<WorktreeDiff> {
  const baseRef = await resolveBase(repo, input);

  const patch = await runGit(
    input.worktreePath,
    ["diff", ...SAFE_DIFF, baseRef],
    { queueKey: repo.root, timeoutMs: 30_000 }
  );
  const files = parseUnifiedDiff(patch);

  const porcelain = await tryGit(
    input.worktreePath,
    ["status", "--porcelain", "-z"],
    { queueKey: repo.root }
  );
  const status = parseStatusZ(porcelain ?? "");

  for (const file of files) {
    file.dirty = status.dirty.has(file.path);
  }

  return { baseRef, files, untracked: status.untracked };
}

/** The Agent tab's "N files +A −D" strip — numstat only, no patch text. */
export async function worktreeDiffSummary(
  repo: RepoInfo,
  input: DiffInput
): Promise<DiffSummary> {
  const baseRef = await resolveBase(repo, input);

  const numstat = await runGit(
    input.worktreePath,
    ["diff", ...SAFE_DIFF, "--numstat", baseRef],
    { queueKey: repo.root }
  );

  let files = 0;
  let additions = 0;
  let deletions = 0;

  for (const line of numstat.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    files += 1;
    const [added, deleted] = line.split("\t");
    // Binary files report "-" instead of a count.
    additions += Number.parseInt(added, 10) || 0;
    deletions += Number.parseInt(deleted, 10) || 0;
  }

  return { additions, deletions, files };
}

/**
 * The badge feed for the file tree: every touched path with the status the
 * tree's git-status lane expects. Cheap by construction — `--name-status`
 * moves file names, never patch text.
 */
export async function worktreeChangedPaths(
  repo: RepoInfo,
  input: DiffInput
): Promise<ChangedPath[]> {
  const baseRef = await resolveBase(repo, input);

  const nameStatus = await runGit(
    input.worktreePath,
    ["diff", ...SAFE_DIFF, "--name-status", "-z", baseRef],
    { queueKey: repo.root }
  );
  const entries = parseNameStatusZ(nameStatus);

  const porcelain = await tryGit(
    input.worktreePath,
    ["status", "--porcelain", "-z"],
    { queueKey: repo.root }
  );
  for (const path of parseStatusZ(porcelain ?? "").untracked) {
    entries.push({ path, status: "untracked" });
  }

  return entries;
}

/** Reads `git diff --name-status -z` records into badge entries. */
function parseNameStatusZ(text: string): ChangedPath[] {
  const entries: ChangedPath[] = [];
  const tokens = text.split("\0");
  let index = 0;

  while (index < tokens.length) {
    const status = tokens[index];
    index += 1;
    if (status.length === 0) {
      continue;
    }

    const [kind] = status;
    if (kind === "R" || kind === "C") {
      // Two path tokens: the original, then the one that exists now.
      const target = tokens[index + 1];
      index += 2;
      if (target) {
        entries.push({
          path: target,
          status: kind === "R" ? "renamed" : "added",
        });
      }
      continue;
    }

    const path = tokens[index];
    index += 1;
    // A deleted file has no tree node to badge.
    if (path && kind !== "D") {
      entries.push({ path, status: kind === "A" ? "added" : "modified" });
    }
  }

  return entries;
}

/**
 * Reads `git status --porcelain -z`: which tracked paths carry uncommitted
 * changes, and which paths git does not know at all.
 */
function parseStatusZ(text: string): {
  dirty: Set<string>;
  untracked: string[];
} {
  const dirty = new Set<string>();
  const untracked: string[] = [];

  const tokens = text.split("\0");
  let index = 0;
  while (index < tokens.length) {
    const entry = tokens[index];
    index += 1;
    if (entry.length < 4) {
      continue;
    }
    const state = entry.slice(0, 2);
    const path = entry.slice(3);

    if (state === "??") {
      untracked.push(path);
      continue;
    }

    dirty.add(path);
    // Renames and copies carry the original path as the next token.
    if (state.includes("R") || state.includes("C")) {
      index += 1;
    }
  }

  return { dirty, untracked };
}
