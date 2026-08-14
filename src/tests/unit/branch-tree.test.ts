import { describe, expect, test } from "vitest";
import { treeRows } from "@/lib/branch/tree";
import type { CanvasNode } from "@/types/branch";

function node(id: string, parentId: string | null): CanvasNode {
  return {
    branch: id,
    detached: false,
    head: "abc",
    id,
    isRoot: parentId === null,
    locked: false,
    parentId,
    parentSource: parentId === null ? "root" : "created",
    prunable: false,
  };
}

/** id → depth, which is all the layout needs from a row. */
function shape(nodes: CanvasNode[]) {
  return treeRows(nodes).map(
    (row) => `${"  ".repeat(row.depth)}${row.node.id}`
  );
}

describe("treeRows", () => {
  test("puts the root first and indents its children", () => {
    expect(shape([node("main", null), node("a", "main")])).toEqual([
      "main",
      "  a",
    ]);
  });

  test("reads depth-first, so a branch sits under the one it came from", () => {
    // Breadth-first would list both children of main before a's own child,
    // which reads as "b came from a" — the one thing the indent must not lie
    // about.
    const nodes = [
      node("main", null),
      node("a", "main"),
      node("b", "main"),
      node("a1", "a"),
    ];

    expect(shape(nodes)).toEqual(["main", "  a", "    a1", "  b"]);
  });

  test("keeps siblings in the order they arrived", () => {
    const nodes = [node("main", null), node("z", "main"), node("a", "main")];

    expect(shape(nodes)).toEqual(["main", "  z", "  a"]);
  });

  test("shows a node whose parent is not in the list", () => {
    // git can list a worktree whose parent branch was deleted. Hiding it would
    // lose a real worktree; it belongs at the top level instead.
    const nodes = [node("main", null), node("orphan", "gone")];

    expect(shape(nodes)).toEqual(["main", "orphan"]);
  });

  test("shows every node exactly once, even in a cycle", () => {
    // Nothing should be able to produce one, but a tree walk that trusts the
    // parent edges would hang rather than draw a wrong picture.
    const nodes = [node("a", "b"), node("b", "a")];
    const rows = treeRows(nodes);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.node.id).sort()).toEqual(["a", "b"]);
  });

  test("does not treat a node as its own parent", () => {
    const rows = treeRows([node("self", "self")]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.depth).toBe(0);
  });

  test("is empty for no nodes", () => {
    expect(treeRows([])).toEqual([]);
  });
});
