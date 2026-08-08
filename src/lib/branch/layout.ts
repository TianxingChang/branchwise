import dagre from "@dagrejs/dagre";
import type { CanvasNode } from "@/types/branch";

export const NODE_WIDTH = 184;
export const NODE_HEIGHT = 56;

export interface Point {
  x: number;
  y: number;
}
export type LayoutResult = Map<string, Point>;

export interface LayoutOptions {
  nodeHeight?: number;
  /** Vertical gap between siblings. */
  nodeSep?: number;
  nodeWidth?: number;
  /** Horizontal gap between a parent and its children. */
  rankSep?: number;
}

/**
 * Lays the branch tree out left-to-right with dagre.
 *
 * Positions are derived, never stored: the tree shape is the only source of
 * truth, so every mutation re-runs this and the whole canvas settles.
 * Returns top-left corners, which is what React Flow expects — dagre reports
 * node centers.
 */
export function layoutTree(
  nodes: CanvasNode[],
  options: LayoutOptions = {}
): LayoutResult {
  const {
    nodeHeight = NODE_HEIGHT,
    nodeSep = 28,
    nodeWidth = NODE_WIDTH,
    rankSep = 96,
  } = options;

  const positions: LayoutResult = new Map();
  if (nodes.length === 0) {
    return positions;
  }

  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ nodesep: nodeSep, rankdir: "LR", ranksep: rankSep });
  graph.setDefaultEdgeLabel(() => ({}));

  const known = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    graph.setNode(node.id, { height: nodeHeight, width: nodeWidth });
  }
  for (const node of nodes) {
    if (node.parentId !== null && known.has(node.parentId)) {
      graph.setEdge(node.parentId, node.id);
    }
  }

  dagre.layout(graph);

  for (const node of nodes) {
    const laid = graph.node(node.id);
    positions.set(node.id, {
      x: laid.x - nodeWidth / 2,
      y: laid.y - nodeHeight / 2,
    });
  }

  return positions;
}
