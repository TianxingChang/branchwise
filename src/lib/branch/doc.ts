import type { BranchNode, GraphDoc } from "@/types/branch";
import { graphDocSchema } from "@/types/branch";
import { DEFAULT_PANEL_WIDTH, MAX_PANEL_WIDTH, MIN_PANEL_WIDTH } from "./tree";

export const GRAPH_DIR = ".branchwise";
export const GRAPH_FILE = "graph.json";

function clampPanelWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return DEFAULT_PANEL_WIDTH;
  }
  return Math.min(
    MAX_PANEL_WIDTH,
    Math.max(MIN_PANEL_WIDTH, Math.round(width))
  );
}

/**
 * A doc can be structurally valid but still describe an impossible tree — a
 * node pointing at a parent that was hand-deleted, or two roots. Rather than
 * rejecting the file (and losing the user's graph) we drop the unreachable
 * parts and keep what still hangs off the first root.
 */
function reconcileTree(nodes: BranchNode[]): BranchNode[] {
  const root = nodes.find((node) => node.parentId === null);
  if (!root) {
    return [];
  }

  const kept: BranchNode[] = [root];
  const reachable = new Set([root.id]);
  let grew = true;

  while (grew) {
    grew = false;
    for (const node of nodes) {
      if (reachable.has(node.id) || node.parentId === null) {
        continue;
      }
      if (reachable.has(node.parentId)) {
        reachable.add(node.id);
        kept.push(node);
        grew = true;
      }
    }
  }

  return kept;
}

/**
 * Validates and repairs a doc read from disk.
 * Returns null when the payload is unusable, so callers can seed a fresh graph.
 */
export function parseGraphDoc(raw: unknown): GraphDoc | null {
  const parsed = graphDocSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }

  const nodes = reconcileTree(parsed.data.nodes);
  if (nodes.length === 0) {
    return null;
  }

  const ids = new Set(nodes.map((node) => node.id));
  const selectedNodeId =
    parsed.data.selectedNodeId && ids.has(parsed.data.selectedNodeId)
      ? parsed.data.selectedNodeId
      : nodes[0].id;

  return {
    ...parsed.data,
    nodes,
    panel: {
      ...parsed.data.panel,
      width: clampPanelWidth(parsed.data.panel.width),
    },
    selectedNodeId,
  };
}

export function serializeGraphDoc(doc: GraphDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
