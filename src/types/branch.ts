import { z } from "zod";

/**
 * A branch node is the unit of work in branchwise: one node, one git branch.
 * Position is never stored — it is derived from the tree by the layout engine.
 */
export const BRANCH_STATUSES = ["idle", "running", "done"] as const;
export type BranchStatus = (typeof BRANCH_STATUSES)[number];

export const PANEL_TABS = [
  "agent",
  "view",
  "terminal",
  "diff",
  "file",
] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

export const branchStatsSchema = z.object({
  done: z.number().int().min(0),
  pending: z.number().int().min(0),
  running: z.number().int().min(0),
});

export const branchNodeSchema = z.object({
  createdAt: z.number().int(),
  id: z.string().min(1),
  name: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  stats: branchStatsSchema,
  status: z.enum(BRANCH_STATUSES),
});

export const panelStateSchema = z.object({
  collapsed: z.boolean(),
  tab: z.enum(PANEL_TABS),
  width: z.number().min(0),
});

export const GRAPH_DOC_VERSION = 1;

export const graphDocSchema = z.object({
  nodes: z.array(branchNodeSchema).min(1),
  panel: panelStateSchema,
  selectedNodeId: z.string().nullable(),
  version: z.literal(GRAPH_DOC_VERSION),
});

export type BranchStats = z.infer<typeof branchStatsSchema>;
export type BranchNode = z.infer<typeof branchNodeSchema>;
export type PanelState = z.infer<typeof panelStateSchema>;
export type GraphDoc = z.infer<typeof graphDocSchema>;
