import { create } from "zustand";
import { loadGraph, saveGraph } from "@/actions/project";
import {
  createWorktree,
  initRepo,
  removeWorktree,
  resolveRepo,
  watchRepo,
} from "@/actions/repo";
import { MAX_PANEL_WIDTH, MIN_PANEL_WIDTH } from "@/lib/branch/constants";
import { createSeedDoc } from "@/lib/branch/doc";
import {
  diffSnapshots,
  migrateAnnotations,
  reparentAnnotations,
  resolveNodeTree,
} from "@/lib/git/resolve";
import type {
  CanvasNode,
  GraphDoc,
  PanelTab,
  RepoInfo,
  RepoSnapshot,
  WorktreeEntry,
} from "@/types/branch";

const SAVE_DEBOUNCE_MS = 300;

export type ProjectStatus =
  | "idle"
  | "resolving"
  | "not-a-repo"
  | "ready"
  | "error";

export interface ProjectState {
  doc: GraphDoc | null;
  error: string | null;
  nodes: CanvasNode[];
  repo: RepoInfo | null;
  status: ProjectStatus;
  worktrees: WorktreeEntry[];
}

export type MutationResult = { ok: true } | { error: string; ok: false };

interface RepoStoreState {
  close: (folder: string) => void;
  createBranch: (
    folder: string,
    startPoint: string,
    name: string
  ) => Promise<MutationResult>;
  deleteNode: (
    folder: string,
    input: {
      branch: string | null;
      deleteBranch: boolean;
      force: boolean;
      worktreePath: string;
    }
  ) => Promise<MutationResult>;
  initialize: (folder: string) => Promise<void>;
  open: (folder: string) => Promise<void>;
  projects: Record<string, ProjectState>;
  selectNode: (folder: string, worktreePath: string | null) => void;
  setPanelCollapsed: (folder: string, collapsed: boolean) => void;
  setPanelTab: (folder: string, tab: PanelTab) => void;
  setPanelWidth: (folder: string, width: number) => void;
}

const EMPTY: ProjectState = {
  doc: null,
  error: null,
  nodes: [],
  repo: null,
  status: "idle",
  worktrees: [],
};

const subscriptions = new Map<string, AbortController>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleSave(repoRoot: string, doc: GraphDoc) {
  const pending = saveTimers.get(repoRoot);
  if (pending) {
    clearTimeout(pending);
  }
  saveTimers.set(
    repoRoot,
    setTimeout(() => {
      saveTimers.delete(repoRoot);
      saveGraph(repoRoot, doc).catch((error) => {
        console.error("Failed to persist branch annotations", error);
      });
    }, SAVE_DEBOUNCE_MS)
  );
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export const useRepoStore = create<RepoStoreState>()((set, get) => {
  function patch(folder: string, update: Partial<ProjectState>) {
    set((state) => ({
      projects: {
        ...state.projects,
        [folder]: { ...(state.projects[folder] ?? EMPTY), ...update },
      },
    }));
  }

  function mutateDoc(folder: string, transform: (doc: GraphDoc) => GraphDoc) {
    const current = get().projects[folder];
    if (!(current?.doc && current.repo)) {
      return;
    }

    const next = transform(current.doc);
    if (next === current.doc) {
      return;
    }

    patch(folder, { doc: next });
    scheduleSave(current.repo.root, next);
  }

  /**
   * Folds one snapshot from git into the project's state.
   *
   * Order matters: annotations are migrated across branch renames *before* the
   * tree is resolved, so a renamed branch keeps its parent edge instead of
   * being re-inferred from a reflog that no longer mentions it.
   */
  function applySnapshot(folder: string, snapshot: RepoSnapshot) {
    const current = get().projects[folder];
    if (!current?.doc) {
      return;
    }

    const diff = diffSnapshots(current.worktrees, snapshot.worktrees);
    const annotations = migrateAnnotations(
      current.doc.branches,
      diff.rebranded
    );

    const { learned, nodes } = resolveNodeTree({
      annotations,
      mainWorktreePath: snapshot.repo.root,
      origins: snapshot.origins,
      worktrees: snapshot.worktrees,
    });

    const live = new Set(nodes.map((node) => node.id));
    const selectedWorktree =
      current.doc.selectedWorktree && live.has(current.doc.selectedWorktree)
        ? current.doc.selectedWorktree
        : null;

    const changedAnnotations =
      annotations !== current.doc.branches || Object.keys(learned).length > 0;

    const doc: GraphDoc = {
      ...current.doc,
      branches: changedAnnotations
        ? { ...annotations, ...learned }
        : annotations,
      selectedWorktree,
    };

    patch(folder, {
      doc,
      error: null,
      nodes,
      repo: snapshot.repo,
      status: "ready",
      worktrees: snapshot.worktrees,
    });

    if (
      changedAnnotations ||
      selectedWorktree !== current.doc.selectedWorktree
    ) {
      scheduleSave(snapshot.repo.root, doc);
    }
  }

  async function follow(folder: string) {
    subscriptions.get(folder)?.abort();
    const controller = new AbortController();
    subscriptions.set(folder, controller);

    try {
      const stream = await watchRepo(folder, controller.signal);
      for await (const snapshot of stream) {
        if (controller.signal.aborted) {
          break;
        }
        applySnapshot(folder, snapshot);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        patch(folder, { error: messageFor(error), status: "error" });
      }
    } finally {
      if (subscriptions.get(folder) === controller) {
        subscriptions.delete(folder);
      }
    }
  }

  async function start(folder: string, repo: RepoInfo) {
    const stored = await loadGraph(repo.root);
    patch(folder, {
      doc: stored ?? createSeedDoc(),
      error: null,
      repo,
      status: "ready",
    });
    follow(folder);
  }

  return {
    close: (folder) => {
      subscriptions.get(folder)?.abort();
      subscriptions.delete(folder);
    },

    createBranch: async (folder, startPoint, name) => {
      const current = get().projects[folder];
      if (!current?.repo) {
        return { error: "The repository is not ready yet.", ok: false };
      }

      try {
        const { worktreePath } = await createWorktree({
          name,
          path: folder,
          startPoint,
        });
        // Select it straight away — the watcher will deliver the node itself.
        mutateDoc(folder, (doc) => ({
          ...doc,
          selectedWorktree: worktreePath,
        }));
        return { ok: true };
      } catch (error) {
        return { error: messageFor(error), ok: false };
      }
    },

    deleteNode: async (folder, input) => {
      const current = get().projects[folder];
      if (!(current?.repo && current.doc)) {
        return { error: "The repository is not ready yet.", ok: false };
      }

      try {
        await removeWorktree({ ...input, path: folder });
      } catch (error) {
        return { error: messageFor(error), ok: false };
      }

      const { branch } = input;
      if (input.deleteBranch && branch) {
        mutateDoc(folder, (doc) => ({
          ...doc,
          branches: reparentAnnotations(doc.branches, branch),
        }));
      }

      return { ok: true };
    },

    initialize: async (folder) => {
      patch(folder, { error: null, status: "resolving" });
      try {
        const repo = await initRepo(folder);
        if (!repo) {
          patch(folder, { status: "not-a-repo" });
          return;
        }
        await start(folder, repo);
      } catch (error) {
        patch(folder, { error: messageFor(error), status: "error" });
      }
    },

    open: async (folder) => {
      const existing = get().projects[folder];
      if (existing?.status === "resolving" || existing?.status === "ready") {
        return;
      }

      patch(folder, { error: null, status: "resolving" });

      try {
        const repo = await resolveRepo(folder);
        if (!repo) {
          patch(folder, { repo: null, status: "not-a-repo" });
          return;
        }
        await start(folder, repo);
      } catch (error) {
        patch(folder, { error: messageFor(error), status: "error" });
      }
    },

    projects: {},

    selectNode: (folder, worktreePath) => {
      mutateDoc(folder, (doc) =>
        doc.selectedWorktree === worktreePath
          ? doc
          : { ...doc, selectedWorktree: worktreePath }
      );
    },

    setPanelCollapsed: (folder, collapsed) => {
      mutateDoc(folder, (doc) => ({
        ...doc,
        panel: { ...doc.panel, collapsed },
      }));
    },

    setPanelTab: (folder, tab) => {
      mutateDoc(folder, (doc) => ({ ...doc, panel: { ...doc.panel, tab } }));
    },

    setPanelWidth: (folder, width) => {
      const clamped = Math.min(
        MAX_PANEL_WIDTH,
        Math.max(MIN_PANEL_WIDTH, Math.round(width))
      );
      mutateDoc(folder, (doc) => ({
        ...doc,
        panel: { ...doc.panel, width: clamped },
      }));
    },
  };
});
