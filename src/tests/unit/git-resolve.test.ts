import { describe, expect, test } from "vitest";
import {
  descendantNodeIds,
  diffSnapshots,
  isEmptyDiff,
  migrateAnnotations,
  type ResolveInput,
  reparentAnnotations,
  resolveNodeTree,
  wouldCreateCycle,
} from "@/lib/git/resolve";
import type { BranchAnnotation, WorktreeEntry } from "@/types/branch";

const ROOT = "/repo";

function worktree(
  path: string,
  branch: string | null,
  overrides: Partial<WorktreeEntry> = {}
): WorktreeEntry {
  return {
    bare: false,
    branch,
    detached: branch === null,
    head: `sha-${path}`,
    locked: false,
    path,
    prunable: false,
    ...overrides,
  };
}

function input(overrides: Partial<ResolveInput> = {}): ResolveInput {
  return {
    annotations: {},
    mainWorktreePath: ROOT,
    origins: {},
    worktrees: [worktree(ROOT, "main")],
    ...overrides,
  };
}

function parentOf(
  nodes: ReturnType<typeof resolveNodeTree>["nodes"],
  id: string
) {
  return nodes.find((node) => node.id === id)?.parentId;
}

describe("resolveNodeTree", () => {
  test("marks the main worktree as the root with no parent", () => {
    const { nodes } = resolveNodeTree(input());

    expect(nodes).toHaveLength(1);
    expect(nodes[0].isRoot).toBe(true);
    expect(nodes[0].parentId).toBeNull();
  });

  test("falls back to the first worktree when the main path is unknown", () => {
    const { nodes } = resolveNodeTree(
      input({ mainWorktreePath: "/somewhere-else" })
    );

    expect(nodes[0].isRoot).toBe(true);
  });

  test("hangs a branch off the parent git recorded", () => {
    const { nodes } = resolveNodeTree(
      input({
        origins: { "feat/a": "main" },
        worktrees: [worktree(ROOT, "main"), worktree("/wt/a", "feat/a")],
      })
    );

    expect(parentOf(nodes, "/wt/a")).toBe(ROOT);
  });

  test("builds a chain when branches come off each other", () => {
    const { nodes } = resolveNodeTree(
      input({
        origins: { "feat/a": "main", "feat/b": "feat/a" },
        worktrees: [
          worktree(ROOT, "main"),
          worktree("/wt/a", "feat/a"),
          worktree("/wt/b", "feat/b"),
        ],
      })
    );

    expect(parentOf(nodes, "/wt/b")).toBe("/wt/a");
    expect(parentOf(nodes, "/wt/a")).toBe(ROOT);
  });

  test("walks past a parent that has no worktree", () => {
    // feat/b came from feat/a, but feat/a was never checked out anywhere, so
    // it is not a node — feat/b must attach to the nearest real ancestor.
    const { nodes } = resolveNodeTree(
      input({
        origins: { "feat/a": "main", "feat/b": "feat/a" },
        worktrees: [worktree(ROOT, "main"), worktree("/wt/b", "feat/b")],
      })
    );

    expect(parentOf(nodes, "/wt/b")).toBe(ROOT);
  });

  test("re-attaches to a middle branch once it gains a worktree", () => {
    const shared = {
      origins: { "feat/a": "main", "feat/b": "feat/a" },
    };

    const without = resolveNodeTree(
      input({
        ...shared,
        worktrees: [worktree(ROOT, "main"), worktree("/wt/b", "feat/b")],
      })
    );
    const with_ = resolveNodeTree(
      input({
        ...shared,
        worktrees: [
          worktree(ROOT, "main"),
          worktree("/wt/a", "feat/a"),
          worktree("/wt/b", "feat/b"),
        ],
      })
    );

    expect(parentOf(without.nodes, "/wt/b")).toBe(ROOT);
    expect(parentOf(with_.nodes, "/wt/b")).toBe("/wt/a");
  });

  test("prefers a stored annotation over what git says", () => {
    const { nodes } = resolveNodeTree(
      input({
        annotations: {
          "feat/b": { parent: "main", parentSource: "user" },
        },
        origins: { "feat/a": "main", "feat/b": "feat/a" },
        worktrees: [
          worktree(ROOT, "main"),
          worktree("/wt/a", "feat/a"),
          worktree("/wt/b", "feat/b"),
        ],
      })
    );

    expect(parentOf(nodes, "/wt/b")).toBe(ROOT);
    expect(nodes.find((n) => n.id === "/wt/b")?.parentSource).toBe("user");
  });

  test("reports inferred parents so they can be persisted", () => {
    const { learned } = resolveNodeTree(
      input({
        origins: { "feat/a": "main" },
        worktrees: [worktree(ROOT, "main"), worktree("/wt/a", "feat/a")],
      })
    );

    expect(learned).toEqual({
      "feat/a": { parent: "main", parentSource: "reflog" },
    });
  });

  test("does not re-learn a branch that is already annotated", () => {
    const { learned } = resolveNodeTree(
      input({
        annotations: { "feat/a": { parent: "main", parentSource: "user" } },
        origins: { "feat/a": "something-else" },
        worktrees: [worktree(ROOT, "main"), worktree("/wt/a", "feat/a")],
      })
    );

    expect(learned).toEqual({});
  });

  test("attaches a detached worktree to the root", () => {
    const { nodes } = resolveNodeTree(
      input({
        worktrees: [worktree(ROOT, "main"), worktree("/wt/loose", null)],
      })
    );

    const loose = nodes.find((node) => node.id === "/wt/loose");
    expect(loose?.parentId).toBe(ROOT);
    expect(loose?.detached).toBe(true);
  });

  test("skips bare repository entries", () => {
    const { nodes } = resolveNodeTree(
      input({
        worktrees: [
          worktree("/repo.git", null, { bare: true }),
          worktree(ROOT, "main"),
        ],
      })
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe(ROOT);
  });

  test("survives a parent cycle in the annotations", () => {
    const { nodes } = resolveNodeTree(
      input({
        annotations: {
          "feat/a": { parent: "feat/b", parentSource: "user" },
          "feat/b": { parent: "feat/a", parentSource: "user" },
        },
        worktrees: [
          worktree(ROOT, "main"),
          worktree("/wt/a", "feat/a"),
          worktree("/wt/b", "feat/b"),
        ],
      })
    );

    const parents = nodes.map((node) => node.parentId);
    expect(parents).not.toContain(undefined);
    // At least one of the pair must have been re-rooted to break the loop.
    expect(parents.filter((parent) => parent === ROOT).length).toBeGreaterThan(
      0
    );
  });

  test("never lets a branch be its own parent", () => {
    const { nodes } = resolveNodeTree(
      input({
        origins: { "feat/a": "feat/a" },
        worktrees: [worktree(ROOT, "main"), worktree("/wt/a", "feat/a")],
      })
    );

    expect(parentOf(nodes, "/wt/a")).toBe(ROOT);
  });

  test("returns nothing when there are no usable worktrees", () => {
    expect(resolveNodeTree(input({ worktrees: [] })).nodes).toEqual([]);
  });
});

describe("diffSnapshots", () => {
  const before = [worktree(ROOT, "main"), worktree("/wt/a", "feat/a")];

  test("sees an added worktree", () => {
    const diff = diffSnapshots(before, [
      ...before,
      worktree("/wt/b", "feat/b"),
    ]);

    expect(diff.added.map((entry) => entry.path)).toEqual(["/wt/b"]);
    expect(isEmptyDiff(diff)).toBe(false);
  });

  test("sees a removed worktree", () => {
    const diff = diffSnapshots(before, [before[0]]);

    expect(diff.removed.map((entry) => entry.path)).toEqual(["/wt/a"]);
  });

  test("is empty when nothing moved", () => {
    expect(isEmptyDiff(diffSnapshots(before, [...before]))).toBe(true);
  });

  test("notices a new commit on the same branch", () => {
    const moved = [before[0], { ...before[1], head: "sha-new" }];

    expect(diffSnapshots(before, moved).changed).toHaveLength(1);
  });

  test("reports a branch swap on an existing worktree", () => {
    const renamed = [before[0], { ...before[1], branch: "feat/renamed" }];
    const diff = diffSnapshots(before, renamed);

    expect(diff.rebranded).toEqual([
      { from: "feat/a", path: "/wt/a", to: "feat/renamed" },
    ]);
  });
});

describe("migrateAnnotations", () => {
  const annotations: Record<string, BranchAnnotation> = {
    "feat/a": { parent: "main", parentSource: "reflog" },
    "feat/b": { parent: "feat/a", parentSource: "reflog" },
  };

  test("carries an annotation onto the new branch name", () => {
    const next = migrateAnnotations(annotations, [
      { from: "feat/a", path: "/wt/a", to: "feat/renamed" },
    ]);

    expect(next["feat/renamed"]).toEqual({
      parent: "main",
      parentSource: "reflog",
    });
    expect(next["feat/a"]).toBeUndefined();
  });

  test("repoints children at the new name", () => {
    const next = migrateAnnotations(annotations, [
      { from: "feat/a", path: "/wt/a", to: "feat/renamed" },
    ]);

    expect(next["feat/b"].parent).toBe("feat/renamed");
  });

  test("is a no-op without renames", () => {
    expect(migrateAnnotations(annotations, [])).toBe(annotations);
  });
});

describe("reparentAnnotations", () => {
  const annotations: Record<string, BranchAnnotation> = {
    "feat/a": { parent: "main", parentSource: "reflog" },
    "feat/b": { parent: "feat/a", parentSource: "reflog" },
    "feat/c": { parent: "feat/a", parentSource: "user" },
    "feat/other": { parent: "main", parentSource: "reflog" },
  };

  test("lifts children onto the removed branch's parent", () => {
    const next = reparentAnnotations(annotations, "feat/a");

    expect(next["feat/b"].parent).toBe("main");
    expect(next["feat/c"].parent).toBe("main");
  });

  test("keeps how each child's edge was decided", () => {
    const next = reparentAnnotations(annotations, "feat/a");

    expect(next["feat/c"].parentSource).toBe("user");
  });

  test("drops the removed branch itself", () => {
    expect(
      reparentAnnotations(annotations, "feat/a")["feat/a"]
    ).toBeUndefined();
  });

  test("leaves unrelated branches alone", () => {
    const next = reparentAnnotations(annotations, "feat/a");

    expect(next["feat/other"]).toEqual(annotations["feat/other"]);
  });

  test("re-roots children when the removed branch had no parent", () => {
    const next = reparentAnnotations(
      { "feat/x": { parent: null, parentSource: "root" }, ...annotations },
      "feat/x"
    );

    expect(next["feat/a"]).toEqual(annotations["feat/a"]);
  });

  test("is safe for a branch that was never annotated", () => {
    expect(reparentAnnotations(annotations, "nope")).toEqual(annotations);
  });
});

describe("wouldCreateCycle", () => {
  const annotations: Record<string, BranchAnnotation> = {
    "feat/a": { parent: "main", parentSource: "reflog" },
    "feat/b": { parent: "feat/a", parentSource: "reflog" },
    "feat/c": { parent: "feat/b", parentSource: "reflog" },
  };

  test("rejects a branch as its own parent", () => {
    expect(wouldCreateCycle(annotations, "feat/a", "feat/a")).toBe(true);
  });

  test("rejects parenting onto a descendant", () => {
    expect(wouldCreateCycle(annotations, "feat/a", "feat/c")).toBe(true);
  });

  test("allows parenting onto an unrelated branch", () => {
    expect(wouldCreateCycle(annotations, "feat/c", "main")).toBe(false);
  });

  test("allows parenting onto an ancestor's sibling", () => {
    const withSibling = {
      ...annotations,
      "feat/side": { parent: "main", parentSource: "reflog" as const },
    };

    expect(wouldCreateCycle(withSibling, "feat/c", "feat/side")).toBe(false);
  });

  test("terminates on an already-corrupt chain", () => {
    const looped: Record<string, BranchAnnotation> = {
      x: { parent: "y", parentSource: "user" },
      y: { parent: "x", parentSource: "user" },
    };

    expect(wouldCreateCycle(looped, "z", "x")).toBe(false);
  });
});

describe("descendantNodeIds", () => {
  const tree = [
    { id: "root", parentId: null },
    { id: "a", parentId: "root" },
    { id: "b", parentId: "a" },
    { id: "c", parentId: "b" },
    { id: "side", parentId: "root" },
  ];

  test("collects the whole subtree", () => {
    expect([...descendantNodeIds(tree, "a")].sort()).toEqual(["b", "c"]);
  });

  test("excludes the node itself", () => {
    expect(descendantNodeIds(tree, "a").has("a")).toBe(false);
  });

  test("returns nothing for a leaf", () => {
    expect(descendantNodeIds(tree, "c").size).toBe(0);
  });

  test("does not wander into a sibling branch", () => {
    expect(descendantNodeIds(tree, "a").has("side")).toBe(false);
  });

  test("terminates on a corrupt cycle", () => {
    const looped = [
      { id: "x", parentId: "y" },
      { id: "y", parentId: "x" },
    ];

    expect(descendantNodeIds(looped, "x").size).toBeLessThanOrEqual(2);
  });
});
