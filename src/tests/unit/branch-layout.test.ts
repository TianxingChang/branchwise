import { describe, expect, test } from "vitest";
import { layoutTree, NODE_HEIGHT, NODE_WIDTH } from "@/lib/branch/layout";
import type { CanvasNode } from "@/types/branch";

const ROOT = "root";

function node(id: string, parentId: string | null): CanvasNode {
  return {
    branch: id,
    detached: false,
    head: `sha-${id}`,
    id,
    isRoot: parentId === null,
    locked: false,
    parentId,
    parentSource: parentId === null ? "root" : "reflog",
    prunable: false,
  };
}

function build(spec: [string, string][]): CanvasNode[] {
  return [node(ROOT, null), ...spec.map(([id, parent]) => node(id, parent))];
}

describe("layoutTree", () => {
  test("returns a position for every node", () => {
    const nodes = build([
      ["a", ROOT],
      ["b", ROOT],
    ]);

    const positions = layoutTree(nodes);

    expect(positions.size).toBe(3);
    for (const item of nodes) {
      expect(positions.get(item.id)).toBeDefined();
    }
  });

  test("places children strictly to the right of their parent", () => {
    const nodes = build([
      ["a", ROOT],
      ["b", "a"],
      ["c", "b"],
    ]);

    const positions = layoutTree(nodes);
    const root = positions.get(ROOT);

    expect(positions.get("a")?.x).toBeGreaterThan(root?.x as number);
    expect(positions.get("b")?.x).toBeGreaterThan(
      positions.get("a")?.x as number
    );
    expect(positions.get("c")?.x).toBeGreaterThan(
      positions.get("b")?.x as number
    );
  });

  test("leaves a horizontal gap wider than a node between ranks", () => {
    const positions = layoutTree(build([["a", ROOT]]), { rankSep: 96 });

    const gap =
      (positions.get("a")?.x as number) - (positions.get(ROOT)?.x as number);

    expect(gap).toBeGreaterThanOrEqual(NODE_WIDTH);
  });

  test("does not overlap siblings vertically", () => {
    const nodes = build([
      ["a", ROOT],
      ["b", ROOT],
      ["c", ROOT],
    ]);
    const positions = layoutTree(nodes);

    const ys = ["a", "b", "c"]
      .map((id) => positions.get(id)?.y as number)
      .sort((left, right) => left - right);

    for (let index = 1; index < ys.length; index += 1) {
      expect(ys[index] - ys[index - 1]).toBeGreaterThanOrEqual(NODE_HEIGHT);
    }
  });

  test("is deterministic for the same tree", () => {
    const nodes = build([
      ["a", ROOT],
      ["b", "a"],
      ["c", ROOT],
    ]);

    const first = layoutTree(nodes);
    const second = layoutTree(nodes);

    for (const [id, point] of first) {
      expect(second.get(id)).toEqual(point);
    }
  });

  test("ignores edges pointing at a parent that is gone", () => {
    const nodes = [node(ROOT, null), node("orphan", "missing")];

    expect(() => layoutTree(nodes)).not.toThrow();
    expect(layoutTree(nodes).size).toBe(2);
  });

  test("handles an empty tree", () => {
    expect(layoutTree([]).size).toBe(0);
  });
});
