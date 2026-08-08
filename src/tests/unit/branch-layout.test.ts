import { describe, expect, test } from "vitest";
import { layoutTree, NODE_HEIGHT, NODE_WIDTH } from "@/lib/branch/layout";
import { addChild, createSeedDoc, ROOT_BRANCH_ID } from "@/lib/branch/tree";
import type { BranchNode } from "@/types/branch";

function build(spec: [string, string][]): BranchNode[] {
  const { nodes: seed } = createSeedDoc(0);
  let nodes = seed;
  for (const [id, parentId] of spec) {
    const { nodes: next } = addChild(nodes, parentId, id, { id, now: 1 });
    nodes = next;
  }
  return nodes;
}

describe("layoutTree", () => {
  test("returns a position for every node", () => {
    const nodes = build([
      ["a", ROOT_BRANCH_ID],
      ["b", ROOT_BRANCH_ID],
    ]);

    const positions = layoutTree(nodes);

    expect(positions.size).toBe(3);
    for (const node of nodes) {
      expect(positions.get(node.id)).toBeDefined();
    }
  });

  test("places children strictly to the right of their parent", () => {
    const nodes = build([
      ["a", ROOT_BRANCH_ID],
      ["b", "a"],
      ["c", "b"],
    ]);

    const positions = layoutTree(nodes);
    const root = positions.get(ROOT_BRANCH_ID);

    expect(positions.get("a")?.x).toBeGreaterThan(root?.x as number);
    expect(positions.get("b")?.x).toBeGreaterThan(
      positions.get("a")?.x as number
    );
    expect(positions.get("c")?.x).toBeGreaterThan(
      positions.get("b")?.x as number
    );
  });

  test("leaves a horizontal gap wider than a node between ranks", () => {
    const nodes = build([["a", ROOT_BRANCH_ID]]);
    const positions = layoutTree(nodes, { rankSep: 96 });

    const gap =
      (positions.get("a")?.x as number) -
      (positions.get(ROOT_BRANCH_ID)?.x as number);

    expect(gap).toBeGreaterThanOrEqual(NODE_WIDTH);
  });

  test("does not overlap siblings vertically", () => {
    const nodes = build([
      ["a", ROOT_BRANCH_ID],
      ["b", ROOT_BRANCH_ID],
      ["c", ROOT_BRANCH_ID],
    ]);

    const ys = ["a", "b", "c"]
      .map((id) => layoutTree(nodes).get(id)?.y as number)
      .sort((left, right) => left - right);

    for (let index = 1; index < ys.length; index += 1) {
      expect(ys[index] - ys[index - 1]).toBeGreaterThanOrEqual(NODE_HEIGHT);
    }
  });

  test("is deterministic for the same tree", () => {
    const nodes = build([
      ["a", ROOT_BRANCH_ID],
      ["b", "a"],
      ["c", ROOT_BRANCH_ID],
    ]);

    const first = layoutTree(nodes);
    const second = layoutTree(nodes);

    for (const [id, point] of first) {
      expect(second.get(id)).toEqual(point);
    }
  });

  test("ignores edges pointing at a parent that is gone", () => {
    const orphan: BranchNode[] = [
      ...createSeedDoc(0).nodes,
      {
        createdAt: 1,
        id: "orphan",
        name: "orphan",
        parentId: "missing",
        stats: { done: 0, pending: 0, running: 0 },
        status: "idle",
      },
    ];

    expect(() => layoutTree(orphan)).not.toThrow();
    expect(layoutTree(orphan).size).toBe(2);
  });

  test("handles an empty tree", () => {
    expect(layoutTree([]).size).toBe(0);
  });
});
