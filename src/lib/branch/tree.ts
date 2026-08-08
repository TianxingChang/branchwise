import type { BranchNode, GraphDoc } from "@/types/branch";
import { GRAPH_DOC_VERSION } from "@/types/branch";

export const ROOT_BRANCH_ID = "main";
export const DEFAULT_PANEL_WIDTH = 420;
export const MIN_PANEL_WIDTH = 340;
export const MAX_PANEL_WIDTH = 760;

/** Characters git refuses in a ref name, plus whitespace we fold into dashes. */
const INVALID_REF_CHARS = /[\s~^:?*[\]\\]+/g;
const REPEATED_DASHES = /-{2,}/g;
const TRIMMABLE_EDGES = /^[-./]+|[-./]+$/g;

/**
 * Fold arbitrary user input into something git would accept as a branch name.
 * Returns an empty string when nothing usable survives.
 */
export function normalizeBranchName(input: string): string {
  return input
    .trim()
    .replace(INVALID_REF_CHARS, "-")
    .replace(REPEATED_DASHES, "-")
    .replace(TRIMMABLE_EDGES, "");
}

export function createNodeId(): string {
  return `br_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function createSeedDoc(now = Date.now()): GraphDoc {
  return {
    nodes: [
      {
        createdAt: now,
        id: ROOT_BRANCH_ID,
        name: "main",
        parentId: null,
        stats: { done: 0, pending: 0, running: 0 },
        status: "idle",
      },
    ],
    panel: { collapsed: false, tab: "agent", width: DEFAULT_PANEL_WIDTH },
    selectedNodeId: ROOT_BRANCH_ID,
    version: GRAPH_DOC_VERSION,
  };
}

export function findNode(
  nodes: BranchNode[],
  id: string
): BranchNode | undefined {
  return nodes.find((node) => node.id === id);
}

export function isNameTaken(
  nodes: BranchNode[],
  name: string,
  exceptId?: string
): boolean {
  return nodes.some((node) => node.id !== exceptId && node.name === name);
}

export function childrenOf(nodes: BranchNode[], id: string): BranchNode[] {
  return nodes.filter((node) => node.parentId === id);
}

/** Every descendant of `id`, excluding `id` itself. */
export function descendantIds(nodes: BranchNode[], id: string): string[] {
  const collected: string[] = [];
  const queue = [id];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const node of nodes) {
      if (node.parentId === current) {
        collected.push(node.id);
        queue.push(node.id);
      }
    }
  }

  return collected;
}

export type TreeError =
  | "duplicate-name"
  | "empty-name"
  | "parent-not-found"
  | "node-not-found"
  | "root-not-removable";

export class BranchTreeError extends Error {
  readonly code: TreeError;

  constructor(code: TreeError, message: string) {
    super(message);
    this.code = code;
    this.name = "BranchTreeError";
  }
}

export function addChild(
  nodes: BranchNode[],
  parentId: string,
  rawName: string,
  options: { id?: string; now?: number } = {}
): { node: BranchNode; nodes: BranchNode[] } {
  const name = normalizeBranchName(rawName);
  if (name.length === 0) {
    throw new BranchTreeError("empty-name", "Branch name cannot be empty.");
  }
  if (!findNode(nodes, parentId)) {
    throw new BranchTreeError(
      "parent-not-found",
      `No branch with id "${parentId}".`
    );
  }
  if (isNameTaken(nodes, name)) {
    throw new BranchTreeError(
      "duplicate-name",
      `A branch named "${name}" already exists.`
    );
  }

  const node: BranchNode = {
    createdAt: options.now ?? Date.now(),
    id: options.id ?? createNodeId(),
    name,
    parentId,
    stats: { done: 0, pending: 0, running: 0 },
    status: "idle",
  };

  return { node, nodes: [...nodes, node] };
}

export function renameNode(
  nodes: BranchNode[],
  id: string,
  rawName: string
): BranchNode[] {
  const name = normalizeBranchName(rawName);
  if (name.length === 0) {
    throw new BranchTreeError("empty-name", "Branch name cannot be empty.");
  }
  if (!findNode(nodes, id)) {
    throw new BranchTreeError("node-not-found", `No branch with id "${id}".`);
  }
  if (isNameTaken(nodes, name, id)) {
    throw new BranchTreeError(
      "duplicate-name",
      `A branch named "${name}" already exists.`
    );
  }

  return nodes.map((node) => (node.id === id ? { ...node, name } : node));
}

/** Removes a node and everything branched off it. The root cannot be removed. */
export function removeSubtree(
  nodes: BranchNode[],
  id: string
): { nodes: BranchNode[]; removedIds: string[] } {
  const target = findNode(nodes, id);
  if (!target) {
    throw new BranchTreeError("node-not-found", `No branch with id "${id}".`);
  }
  if (target.parentId === null) {
    throw new BranchTreeError(
      "root-not-removable",
      "The root branch cannot be deleted."
    );
  }

  const removedIds = [id, ...descendantIds(nodes, id)];
  const removed = new Set(removedIds);

  return {
    nodes: nodes.filter((node) => !removed.has(node.id)),
    removedIds,
  };
}

/** Suggests `branch-1`, `branch-2`, … skipping names already in use. */
export function suggestBranchName(
  nodes: BranchNode[],
  prefix = "branch"
): string {
  let index = nodes.length;
  let candidate = `${prefix}-${index}`;
  while (isNameTaken(nodes, candidate)) {
    index += 1;
    candidate = `${prefix}-${index}`;
  }
  return candidate;
}
