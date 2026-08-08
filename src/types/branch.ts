import { z } from "zod";

export const PANEL_TABS = [
  "agent",
  "view",
  "terminal",
  "diff",
  "file",
] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

/** How a node's parent edge was decided. Drives how the edge is drawn. */
export const PARENT_SOURCES = ["created", "reflog", "user", "root"] as const;
export type ParentSource = (typeof PARENT_SOURCES)[number];

/**
 * One entry of `git worktree list --porcelain`. This is the authoritative
 * description of a node — branchwise never invents these.
 */
export const worktreeEntrySchema = z.object({
  bare: z.boolean(),
  /** Short branch name ("feat/a"), or null when detached or bare. */
  branch: z.string().nullable(),
  detached: z.boolean(),
  head: z.string(),
  locked: z.boolean(),
  path: z.string(),
  /** Git still lists a worktree whose directory was deleted by hand. */
  prunable: z.boolean(),
});

export const repoInfoSchema = z.object({
  /** Absolute path of the shared .git directory. */
  commonDir: z.string(),
  /** Branch checked out in the main worktree, null when detached. */
  headBranch: z.string().nullable(),
  /** True for a freshly `git init`ed repo with no commits — HEAD is unborn. */
  isEmpty: z.boolean(),
  /** Absolute path of the main worktree. */
  root: z.string(),
  /** Sibling directory branchwise creates worktrees in. */
  worktreeRoot: z.string(),
});

export const repoSnapshotSchema = z.object({
  /** Branch name → the branch it was created from, as git remembers it. */
  origins: z.record(z.string(), z.string().nullable()),
  repo: repoInfoSchema,
  worktrees: z.array(worktreeEntrySchema),
});

export const worktreeStatusSchema = z.object({
  /** Number of uncommitted entries in the worktree. */
  dirtyCount: z.number().int().min(0),
  /** True when the branch is already contained in its parent. */
  merged: z.boolean(),
});

export const branchAnnotationSchema = z.object({
  /**
   * Provenance parent as a *branch name*, not a node. The parent may have no
   * worktree today and gain one later, at which point the edge snaps to it.
   */
  parent: z.string().nullable(),
  parentSource: z.enum(PARENT_SOURCES),
});

export const panelStateSchema = z.object({
  collapsed: z.boolean(),
  tab: z.enum(PANEL_TABS),
  width: z.number().min(0),
});

export const GRAPH_DOC_VERSION = 2;

/**
 * What branchwise stores per project. Deliberately *not* a node list: git owns
 * which nodes exist, this file only annotates them.
 */
export const graphDocSchema = z.object({
  branches: z.record(z.string(), branchAnnotationSchema),
  panel: panelStateSchema,
  /** Worktree path of the selected node, or null for "nothing selected". */
  selectedWorktree: z.string().nullable(),
  version: z.literal(GRAPH_DOC_VERSION),
});

export type WorktreeEntry = z.infer<typeof worktreeEntrySchema>;
export type RepoInfo = z.infer<typeof repoInfoSchema>;
export type RepoSnapshot = z.infer<typeof repoSnapshotSchema>;
export type BranchAnnotation = z.infer<typeof branchAnnotationSchema>;
export type WorktreeStatus = z.infer<typeof worktreeStatusSchema>;
export type PanelState = z.infer<typeof panelStateSchema>;
export type GraphDoc = z.infer<typeof graphDocSchema>;

/** A node on the canvas: one worktree, positioned by the layout engine. */
export interface CanvasNode {
  branch: string | null;
  detached: boolean;
  head: string;
  /** The worktree path — stable across branch renames, so it is the identity. */
  id: string;
  isRoot: boolean;
  locked: boolean;
  parentId: string | null;
  parentSource: ParentSource;
  prunable: boolean;
}
