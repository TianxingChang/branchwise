import { create } from "zustand";
import { loadGraph, saveGraph } from "@/actions/project";
import {
  addChild,
  BranchTreeError,
  createSeedDoc,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  removeSubtree,
  renameNode,
} from "@/lib/branch/tree";
import type { GraphDoc, PanelTab } from "@/types/branch";

const SAVE_DEBOUNCE_MS = 300;

export type ProjectGraphStatus = "idle" | "loading" | "ready" | "error";

export interface ProjectGraphState {
  doc: GraphDoc | null;
  error: string | null;
  status: ProjectGraphStatus;
}

export type MutationResult =
  | { ok: true; nodeId?: string }
  | { error: string; ok: false };

interface GraphStoreState {
  addBranch: (path: string, parentId: string, name: string) => MutationResult;
  load: (path: string) => Promise<void>;
  projects: Record<string, ProjectGraphState>;
  removeBranch: (path: string, nodeId: string) => MutationResult;
  renameBranch: (path: string, nodeId: string, name: string) => MutationResult;
  selectNode: (path: string, nodeId: string | null) => void;
  setPanelCollapsed: (path: string, collapsed: boolean) => void;
  setPanelTab: (path: string, tab: PanelTab) => void;
  setPanelWidth: (path: string, width: number) => void;
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleSave(path: string, doc: GraphDoc) {
  const pending = saveTimers.get(path);
  if (pending) {
    clearTimeout(pending);
  }

  saveTimers.set(
    path,
    setTimeout(() => {
      saveTimers.delete(path);
      saveGraph(path, doc).catch((error) => {
        console.error("Failed to persist graph", error);
      });
    }, SAVE_DEBOUNCE_MS)
  );
}

function messageFor(error: unknown): string {
  if (error instanceof BranchTreeError) {
    return error.message;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

export const useGraphStore = create<GraphStoreState>()((set, get) => {
  /** Applies a pure transform to a loaded doc and persists the result. */
  function mutate(path: string, transform: (doc: GraphDoc) => GraphDoc) {
    const current = get().projects[path]?.doc;
    if (!current) {
      return;
    }

    const next = transform(current);
    set((state) => ({
      projects: {
        ...state.projects,
        [path]: { ...state.projects[path], doc: next },
      },
    }));
    scheduleSave(path, next);
  }

  return {
    addBranch: (path, parentId, name) => {
      const current = get().projects[path]?.doc;
      if (!current) {
        return { error: "Project is not loaded yet.", ok: false };
      }

      try {
        const { node, nodes } = addChild(current.nodes, parentId, name);
        mutate(path, (doc) => ({ ...doc, nodes, selectedNodeId: node.id }));
        return { nodeId: node.id, ok: true };
      } catch (error) {
        return { error: messageFor(error), ok: false };
      }
    },

    load: async (path) => {
      const existing = get().projects[path];
      if (existing?.status === "loading" || existing?.status === "ready") {
        return;
      }

      set((state) => ({
        projects: {
          ...state.projects,
          [path]: { doc: null, error: null, status: "loading" },
        },
      }));

      try {
        const stored = await loadGraph(path);
        const doc = stored ?? createSeedDoc();
        set((state) => ({
          projects: {
            ...state.projects,
            [path]: { doc, error: null, status: "ready" },
          },
        }));
        if (!stored) {
          scheduleSave(path, doc);
        }
      } catch (error) {
        set((state) => ({
          projects: {
            ...state.projects,
            [path]: { doc: null, error: messageFor(error), status: "error" },
          },
        }));
      }
    },

    projects: {},

    removeBranch: (path, nodeId) => {
      const current = get().projects[path]?.doc;
      if (!current) {
        return { error: "Project is not loaded yet.", ok: false };
      }

      try {
        const target = current.nodes.find((node) => node.id === nodeId);
        const { nodes, removedIds } = removeSubtree(current.nodes, nodeId);
        const removed = new Set(removedIds);
        const selectedNodeId =
          current.selectedNodeId && removed.has(current.selectedNodeId)
            ? (target?.parentId ?? nodes[0].id)
            : current.selectedNodeId;

        mutate(path, (doc) => ({ ...doc, nodes, selectedNodeId }));
        return { ok: true };
      } catch (error) {
        return { error: messageFor(error), ok: false };
      }
    },

    renameBranch: (path, nodeId, name) => {
      const current = get().projects[path]?.doc;
      if (!current) {
        return { error: "Project is not loaded yet.", ok: false };
      }

      try {
        const nodes = renameNode(current.nodes, nodeId, name);
        mutate(path, (doc) => ({ ...doc, nodes }));
        return { ok: true };
      } catch (error) {
        return { error: messageFor(error), ok: false };
      }
    },

    selectNode: (path, nodeId) => {
      mutate(path, (doc) =>
        doc.selectedNodeId === nodeId ? doc : { ...doc, selectedNodeId: nodeId }
      );
    },

    setPanelCollapsed: (path, collapsed) => {
      mutate(path, (doc) => ({
        ...doc,
        panel: { ...doc.panel, collapsed },
      }));
    },

    setPanelTab: (path, tab) => {
      mutate(path, (doc) => ({ ...doc, panel: { ...doc.panel, tab } }));
    },

    setPanelWidth: (path, width) => {
      const clamped = Math.min(
        MAX_PANEL_WIDTH,
        Math.max(MIN_PANEL_WIDTH, Math.round(width))
      );
      mutate(path, (doc) => ({
        ...doc,
        panel: { ...doc.panel, width: clamped },
      }));
    },
  };
});
