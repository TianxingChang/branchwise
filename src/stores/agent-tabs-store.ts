import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { FIRST_CONVERSATION } from "@/lib/agent/identity";

export interface WorktreeConversations {
  activeId: string;
  /** Oldest first — the order the strip lists them in. */
  ids: string[];
  /** The highest id ever issued here. Only ever climbs. */
  sequence: number;
}

interface AgentTabsState {
  byWorktree: Record<string, WorktreeConversations>;
  close: (worktreePath: string, conversationId: string) => void;
  focus: (worktreePath: string, conversationId: string) => void;
  open: (worktreePath: string) => string;
}

const EMPTY: WorktreeConversations = {
  activeId: FIRST_CONVERSATION,
  ids: [FIRST_CONVERSATION],
  sequence: 1,
};

function stateOf(
  byWorktree: Record<string, WorktreeConversations>,
  worktreePath: string
): WorktreeConversations {
  return byWorktree[worktreePath] ?? EMPTY;
}

/** Whichever conversation should take focus once `removed` is gone. */
function survivorOf(ids: string[], removed: string): string {
  const at = ids.indexOf(removed);
  const remaining = ids.filter((id) => id !== removed);
  return remaining[Math.min(at, remaining.length - 1)] ?? FIRST_CONVERSATION;
}

/**
 * Which conversations each worktree has, and which one is on screen.
 *
 * Persisted, unlike the terminal's equivalent, and for the opposite reason: a
 * pty dies with the app, so restoring a shell layout would promise state the
 * shells no longer have — whereas a conversation is a transcript on disk that
 * outlives the app entirely. Forget that conversation 3 exists and its
 * transcript is still there, keyed by an id nothing will ask for again.
 *
 * localStorage rather than the project's graph.json, on the same argument that
 * keeps panel width out of it: which conversations someone has open is a fact
 * about this machine, not about the repository.
 */
export const useAgentTabsStore = create<AgentTabsState>()(
  persist(
    (set, get) => ({
      byWorktree: {},

      close: (worktreePath, conversationId) =>
        set((state) => {
          const current = stateOf(state.byWorktree, worktreePath);
          // The tab always shows a conversation, and the first one owns the
          // history every branch already has. Closing it would hide that
          // behind nothing.
          if (current.ids.length <= 1) {
            return state;
          }

          return {
            byWorktree: {
              ...state.byWorktree,
              [worktreePath]: {
                ...current,
                activeId:
                  current.activeId === conversationId
                    ? survivorOf(current.ids, conversationId)
                    : current.activeId,
                ids: current.ids.filter((id) => id !== conversationId),
              },
            },
          };
        }),

      focus: (worktreePath, conversationId) =>
        set((state) => {
          const current = stateOf(state.byWorktree, worktreePath);
          if (current.activeId === conversationId) {
            return state;
          }
          return {
            byWorktree: {
              ...state.byWorktree,
              [worktreePath]: { ...current, activeId: conversationId },
            },
          };
        }),

      open: (worktreePath) => {
        // Counted, never derived from the live list: a closed conversation's
        // transcript stays on disk under its id, and reissuing that id would
        // open a "new" conversation onto somebody else's history.
        const sequence = stateOf(get().byWorktree, worktreePath).sequence + 1;
        const id = String(sequence);

        set((state) => {
          const current = stateOf(state.byWorktree, worktreePath);
          return {
            byWorktree: {
              ...state.byWorktree,
              [worktreePath]: {
                activeId: id,
                ids: [...current.ids, id],
                sequence,
              },
            },
          };
        });

        return id;
      },
    }),
    {
      name: "branchwise.agent-tabs",
      storage: createJSONStorage(() => localStorage),
    }
  )
);

/** Read-only view of one worktree's conversations, defaulted for a fresh tab. */
export function conversationsOf(
  state: AgentTabsState,
  worktreePath: string
): WorktreeConversations {
  return stateOf(state.byWorktree, worktreePath);
}
