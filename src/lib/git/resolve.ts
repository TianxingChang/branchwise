import type {
  BranchAnnotation,
  CanvasNode,
  ParentSource,
  WorktreeEntry,
} from "@/types/branch";

export interface ResolveInput {
  /** Branch name → stored annotation. User corrections live here. */
  annotations: Record<string, BranchAnnotation>;
  mainWorktreePath: string;
  /** Branch name → branch it was created from, as recovered from git. */
  origins: Record<string, string | null>;
  worktrees: WorktreeEntry[];
}

export interface ResolveResult {
  /** Newly inferred annotations the caller should persist. */
  learned: Record<string, BranchAnnotation>;
  nodes: CanvasNode[];
}

function rawParentOf(
  branch: string,
  input: ResolveInput
): { parent: string | null; source: ParentSource } | null {
  const annotation = input.annotations[branch];
  if (annotation) {
    return { parent: annotation.parent, source: annotation.parentSource };
  }

  if (branch in input.origins) {
    const parent = input.origins[branch];
    return { parent, source: parent === null ? "root" : "reflog" };
  }

  return null;
}

/**
 * Follows a provenance chain of branch names until it reaches one that actually
 * has a worktree — that is the nearest real node.
 *
 * A branch is frequently created from another branch that has no worktree of
 * its own, and such a branch is not a node. Walking up keeps the canvas a
 * connected tree instead of sprouting orphans.
 */
function walkToNearestNode(
  start: string | null,
  selfPath: string,
  branchToPath: Map<string, string>,
  input: ResolveInput
): string | null {
  const visited = new Set<string>();
  let current = start;

  while (current !== null) {
    const path = branchToPath.get(current);
    if (path !== undefined && path !== selfPath) {
      return path;
    }

    if (visited.has(current)) {
      return null;
    }
    visited.add(current);

    const next =
      input.annotations[current]?.parent ?? input.origins[current] ?? null;
    current = next;
  }

  return null;
}

/** Re-roots any node caught in a parent cycle, which user edits can create. */
function breakCycles(nodes: CanvasNode[], rootId: string): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));

  for (const node of nodes) {
    const seen = new Set<string>([node.id]);
    let cursor = node.parentId;

    while (cursor !== null) {
      if (seen.has(cursor)) {
        node.parentId = rootId;
        node.parentSource = "root";
        break;
      }
      seen.add(cursor);
      cursor = byId.get(cursor)?.parentId ?? null;
    }
  }
}

/**
 * Turns the authoritative worktree list into canvas nodes with parent edges.
 *
 * Existence comes entirely from `worktrees`; this function only decides who
 * hangs off whom, and reports which parents it had to infer so they can be
 * written down before the reflog they came from expires.
 */
export function resolveNodeTree(input: ResolveInput): ResolveResult {
  const usable = input.worktrees.filter((entry) => !entry.bare);
  if (usable.length === 0) {
    return { learned: {}, nodes: [] };
  }

  const root =
    usable.find((entry) => entry.path === input.mainWorktreePath) ?? usable[0];

  const branchToPath = new Map<string, string>();
  for (const entry of usable) {
    if (entry.branch !== null) {
      branchToPath.set(entry.branch, entry.path);
    }
  }

  const learned: Record<string, BranchAnnotation> = {};

  const nodes: CanvasNode[] = usable.map((entry) => {
    const isRoot = entry.path === root.path;

    if (isRoot || entry.branch === null) {
      return {
        branch: entry.branch,
        detached: entry.detached,
        head: entry.head,
        id: entry.path,
        isRoot,
        locked: entry.locked,
        parentId: isRoot ? null : root.path,
        parentSource: "root",
        prunable: entry.prunable,
      };
    }

    const raw = rawParentOf(entry.branch, input);

    if (raw && !(entry.branch in input.annotations)) {
      learned[entry.branch] = { parent: raw.parent, parentSource: raw.source };
    }

    const parentId = raw
      ? walkToNearestNode(raw.parent, entry.path, branchToPath, input)
      : null;

    return {
      branch: entry.branch,
      detached: entry.detached,
      head: entry.head,
      id: entry.path,
      isRoot,
      locked: entry.locked,
      parentId: parentId ?? root.path,
      parentSource: parentId === null ? "root" : (raw?.source ?? "root"),
      prunable: entry.prunable,
    };
  });

  breakCycles(nodes, root.path);

  return { learned, nodes };
}

export interface SnapshotDiff {
  added: WorktreeEntry[];
  changed: { from: WorktreeEntry; to: WorktreeEntry }[];
  /** Same worktree, different branch — i.e. a rename or a `git switch`. */
  rebranded: { from: string; path: string; to: string }[];
  removed: WorktreeEntry[];
}

function sameEntry(left: WorktreeEntry, right: WorktreeEntry): boolean {
  return (
    left.branch === right.branch &&
    left.head === right.head &&
    left.detached === right.detached &&
    left.locked === right.locked &&
    left.prunable === right.prunable &&
    left.bare === right.bare
  );
}

export function diffSnapshots(
  previous: WorktreeEntry[],
  next: WorktreeEntry[]
): SnapshotDiff {
  const before = new Map(previous.map((entry) => [entry.path, entry]));
  const after = new Map(next.map((entry) => [entry.path, entry]));

  const diff: SnapshotDiff = {
    added: [],
    changed: [],
    rebranded: [],
    removed: [],
  };

  for (const entry of next) {
    const old = before.get(entry.path);
    if (!old) {
      diff.added.push(entry);
      continue;
    }
    if (!sameEntry(old, entry)) {
      diff.changed.push({ from: old, to: entry });
      if (
        old.branch !== null &&
        entry.branch !== null &&
        old.branch !== entry.branch
      ) {
        diff.rebranded.push({
          from: old.branch,
          path: entry.path,
          to: entry.branch,
        });
      }
    }
  }

  for (const entry of previous) {
    if (!after.has(entry.path)) {
      diff.removed.push(entry);
    }
  }

  return diff;
}

export function isEmptyDiff(diff: SnapshotDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0
  );
}

/**
 * Carries annotations across a branch rename.
 *
 * The worktree path survives `git branch -m`, so it can be used to recognise
 * that the branch under a node is the same work under a new name, and the
 * parent edge does not have to be re-inferred.
 */
export function migrateAnnotations(
  annotations: Record<string, BranchAnnotation>,
  rebranded: SnapshotDiff["rebranded"]
): Record<string, BranchAnnotation> {
  if (rebranded.length === 0) {
    return annotations;
  }

  const next = { ...annotations };

  for (const rename of rebranded) {
    const carried = next[rename.from];
    if (carried && !next[rename.to]) {
      next[rename.to] = carried;
      delete next[rename.from];
    }

    // Anything that pointed at the old name follows it.
    for (const [branch, annotation] of Object.entries(next)) {
      if (annotation.parent === rename.from) {
        next[branch] = { ...annotation, parent: rename.to };
      }
    }
  }

  return next;
}

/**
 * Removes a branch's annotation and lifts its children onto its parent.
 *
 * Git does not cascade: the children are independent worktrees that outlive
 * their parent branch. Re-pointing them keeps the canvas tree connected
 * instead of dropping a whole subtree back onto the root.
 */
export function reparentAnnotations(
  annotations: Record<string, BranchAnnotation>,
  removedBranch: string
): Record<string, BranchAnnotation> {
  const grandparent = annotations[removedBranch]?.parent ?? null;
  const next: Record<string, BranchAnnotation> = {};

  for (const [branch, annotation] of Object.entries(annotations)) {
    if (branch === removedBranch) {
      continue;
    }
    next[branch] =
      annotation.parent === removedBranch
        ? { ...annotation, parent: grandparent }
        : annotation;
  }

  return next;
}

/**
 * Whether re-parenting `child` onto `parent` would close a loop.
 *
 * Checked before the edge is written rather than repaired afterwards: silently
 * re-rooting a node the user just dragged would look like the drag failed.
 */
export function wouldCreateCycle(
  annotations: Record<string, BranchAnnotation>,
  child: string,
  parent: string
): boolean {
  if (child === parent) {
    return true;
  }

  const visited = new Set<string>();
  let cursor: string | null = parent;

  while (cursor !== null) {
    if (cursor === child) {
      return true;
    }
    if (visited.has(cursor)) {
      return false;
    }
    visited.add(cursor);
    cursor = annotations[cursor]?.parent ?? null;
  }

  return false;
}

/**
 * Every node beneath `id` in the resolved tree.
 *
 * Used to keep a node's own descendants out of its list of candidate parents —
 * choosing one would be a loop.
 */
export function descendantNodeIds(
  nodes: Pick<CanvasNode, "id" | "parentId">[],
  id: string
): Set<string> {
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId !== null) {
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node.id);
      children.set(node.parentId, siblings);
    }
  }

  const found = new Set<string>();
  const queue = [id];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const child of children.get(current) ?? []) {
      if (!found.has(child)) {
        found.add(child);
        queue.push(child);
      }
    }
  }

  return found;
}
