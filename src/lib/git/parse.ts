import type { WorktreeEntry } from "@/types/branch";

const HEADS_PREFIX = "refs/heads/";
const WORKTREE_KEY = "worktree";

/**
 * Parses `git worktree list --porcelain`.
 *
 * Records are separated by blank lines. Each line is either `key value` or a
 * bare flag (`bare`, `detached`), and `locked`/`prunable` may or may not carry
 * a reason. Unknown keys are ignored so a newer git cannot break us.
 */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  const prefix = `${WORKTREE_KEY} `;

  for (const rawLine of porcelain.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.length === 0) {
      continue;
    }

    if (line.startsWith(prefix)) {
      entries.push(emptyEntry(line.slice(prefix.length)));
      continue;
    }

    const entry = entries.at(-1);
    if (entry) {
      applyField(entry, line);
    }
  }

  return entries;
}

function emptyEntry(path: string): WorktreeEntry {
  return {
    bare: false,
    branch: null,
    detached: false,
    head: "",
    locked: false,
    path,
    prunable: false,
  };
}

/**
 * Applies one `key value` line. `locked` and `prunable` may arrive bare or with
 * a reason, and unknown keys are ignored so a newer git cannot break us.
 */
function applyField(entry: WorktreeEntry, line: string): void {
  const separator = line.indexOf(" ");
  const key = separator === -1 ? line : line.slice(0, separator);
  const value = separator === -1 ? "" : line.slice(separator + 1);

  switch (key) {
    case "HEAD":
      entry.head = value;
      break;
    case "branch":
      entry.branch = value.startsWith(HEADS_PREFIX)
        ? value.slice(HEADS_PREFIX.length)
        : value;
      break;
    case "bare":
      entry.bare = true;
      break;
    case "detached":
      entry.detached = true;
      break;
    case "locked":
      entry.locked = true;
      break;
    case "prunable":
      entry.prunable = true;
      break;
    default:
      break;
  }
}

export type BranchOrigin =
  | { kind: "ref"; ref: string }
  | { kind: "head" }
  | null;

const CREATED_FROM = /^branch: Created from (.+)$/;
const HEADS_REF_PREFIX = /^refs\/heads\//;

/**
 * Reads the first reflog subject of a branch.
 *
 * Git records where a branch came from — `branch: Created from feat/a` when the
 * start point was named, `branch: Created from HEAD` when it was implicit. The
 * named form is the only exact parent evidence git offers; `HEAD` needs a
 * second inference step against the commit it pointed at.
 */
export function parseBranchOrigin(reflogSubject: string): BranchOrigin {
  const match = CREATED_FROM.exec(reflogSubject.trim());
  if (!match) {
    return null;
  }

  const ref = match[1].trim();
  if (ref === "HEAD") {
    return { kind: "head" };
  }

  return { kind: "ref", ref: ref.replace(HEADS_REF_PREFIX, "") };
}
