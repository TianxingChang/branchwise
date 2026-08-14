import type { CanvasNode } from "@/types/branch";

export interface TreeRow {
  /** How far the row is indented: 0 for a root. */
  depth: number;
  node: CanvasNode;
}

/**
 * The same hierarchy the canvas draws, flattened into rows.
 *
 * Depth-first rather than breadth-first, so a branch is listed directly under
 * the one it came from. Breadth-first would put every child of main together
 * and a grandchild below all of them, which reads as though the grandchild
 * came from the last sibling — the one thing an indent must not lie about.
 *
 * Siblings keep the order they arrived in, which is the order git listed the
 * worktrees. Sorting them by name would reshuffle the tree whenever a branch
 * is renamed, and the point of a tree is that things stay where you left them.
 */
export function treeRows(nodes: CanvasNode[]): TreeRow[] {
  const childrenOf = new Map<string, CanvasNode[]>();
  const known = new Set(nodes.map((node) => node.id));

  const roots: CanvasNode[] = [];
  for (const node of nodes) {
    // A worktree whose parent branch was deleted is still a worktree. It goes
    // to the top level rather than disappearing with the parent git forgot.
    const parentId =
      node.parentId !== null && node.parentId !== node.id
        ? node.parentId
        : null;

    if (parentId === null || !known.has(parentId)) {
      roots.push(node);
      continue;
    }
    const siblings = childrenOf.get(parentId) ?? [];
    siblings.push(node);
    childrenOf.set(parentId, siblings);
  }

  const rows: TreeRow[] = [];
  // Nothing should be able to produce a cycle, but a walk that simply trusts
  // the parent edges would hang on one rather than draw a wrong picture.
  const drawn = new Set<string>();

  const walk = (node: CanvasNode, depth: number) => {
    if (drawn.has(node.id)) {
      return;
    }
    drawn.add(node.id);
    rows.push({ depth, node });
    for (const child of childrenOf.get(node.id) ?? []) {
      walk(child, depth + 1);
    }
  };

  for (const root of roots) {
    walk(root, 0);
  }

  // Anything left is inside a cycle and was never reached from a root. It is
  // still a real worktree, so it is listed rather than silently dropped.
  for (const node of nodes) {
    walk(node, 0);
  }

  return rows;
}
