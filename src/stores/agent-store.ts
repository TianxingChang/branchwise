import { create } from "zustand";
import type { AgentTarget } from "@/actions/agent";
import {
  agentHistory,
  attachAgent,
  getAgentConfig,
  interruptAgent,
  respondAgentPermission,
  sendAgentMessage,
  setAgentConfig,
} from "@/actions/agent";
import {
  type ConversationState,
  emptyConversation,
  foldEvent,
} from "@/lib/agent/fold";
import { agentKey, worktreeOfKey } from "@/lib/agent/identity";
import type { AgentConfig, AgentEvent } from "@/types/agent";

/** What a worktree's first turn was seeded from, for the badge in AgentTab. */
export interface AgentInheritance {
  at: number;
  from: string;
  mode: "brief" | "full";
  /** Absent only for a record persisted before this field existed — the
   * badge falls back to a path-tail label in that case. */
  parentLabel?: string;
}

export interface AgentSession {
  attached: boolean;
  config: AgentConfig | null;
  conversation: ConversationState;
  hasConversation: boolean;
  inherited: AgentInheritance | null;
}

const realActions = {
  agentHistory,
  attachAgent,
  getAgentConfig,
  interruptAgent,
  respondAgentPermission,
  sendAgentMessage,
  setAgentConfig,
};

type AgentActionsShape = typeof realActions;

let actions: AgentActionsShape = realActions;

/** Test seam: swap the IPC-backed actions for fakes. */
export function _setAgentActionsForTests(fake: AgentActionsShape): void {
  actions = fake;
}

const EMPTY_SESSION: AgentSession = {
  attached: false,
  config: null,
  conversation: emptyConversation(),
  hasConversation: false,
  inherited: null,
};

/**
 * The transcript contains every event ever flushed, including the active
 * turn's; the attach replay re-delivers exactly that active turn. Trimming
 * history back to its last turn-done removes the overlap, so fold(history') +
 * fold(replay + live) is duplicate-free and deterministic.
 */
export function trimToLastTurnDone(events: AgentEvent[]): AgentEvent[] {
  const lastDone = events.findLastIndex((event) => event.kind === "turn-done");
  return lastDone < 0 ? [] : events.slice(0, lastDone + 1);
}

interface AgentStoreState {
  close: (target: AgentTarget) => void;
  configure: (target: AgentTarget, config: AgentConfig) => Promise<void>;
  interrupt: (target: AgentTarget) => Promise<void>;
  open: (target: AgentTarget) => Promise<void>;
  reset: () => void;
  respond: (
    target: AgentTarget,
    requestId: string,
    approved: boolean
  ) => Promise<void>;
  sendMessage: (target: AgentTarget, text: string) => Promise<void>;
  /** Keyed by conversation, so a worktree can hold several at once. */
  sessions: Record<string, AgentSession>;
}

/** The store's key for a target — the same one the main process files it under. */
function keyOf(target: AgentTarget): string {
  return agentKey(target.worktreePath, target.conversationId);
}

const controllers = new Map<string, AbortController>();

export const useAgentStore = create<AgentStoreState>()((set) => {
  function patch(
    key: string,
    update: (session: AgentSession) => AgentSession
  ): void {
    set((state) => ({
      sessions: {
        ...state.sessions,
        [key]: update(state.sessions[key] ?? EMPTY_SESSION),
      },
    }));
  }

  return {
    close: (target) => {
      const key = keyOf(target);
      controllers.get(key)?.abort();
      controllers.delete(key);
      patch(key, (session) => ({ ...session, attached: false }));
    },

    configure: async (target, config) => {
      await actions.setAgentConfig(target, config);
      patch(keyOf(target), (session) => ({ ...session, config }));
    },

    interrupt: async (target) => {
      await actions.interruptAgent(target);
    },

    open: async (target) => {
      const key = keyOf(target);
      controllers.get(key)?.abort();
      const controller = new AbortController();
      controllers.set(key, controller);

      const [meta, history] = await Promise.all([
        actions.getAgentConfig(target),
        actions.agentHistory(target),
      ]);
      if (controller.signal.aborted) {
        return;
      }
      const folded = trimToLastTurnDone(history).reduce(
        foldEvent,
        emptyConversation()
      );
      patch(key, () => ({
        attached: true,
        config: meta.config,
        conversation: folded,
        hasConversation: meta.hasConversation,
        inherited: meta.inherited,
      }));

      const stream = await actions.attachAgent(target, controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      (async () => {
        try {
          for await (const event of stream) {
            if (controller.signal.aborted) {
              return;
            }
            patch(key, (session) => ({
              ...session,
              conversation: foldEvent(session.conversation, event),
              hasConversation: true,
            }));
          }
        } catch {
          // Stream ended by reload/abort: state stays; reopen re-syncs.
        }
      })();
    },

    reset: () => {
      for (const controller of controllers.values()) {
        controller.abort();
      }
      controllers.clear();
      set({ sessions: {} });
    },

    respond: async (target, requestId, approved) => {
      await actions.respondAgentPermission({ ...target, approved, requestId });
    },

    sendMessage: async (target, text) => {
      await actions.sendAgentMessage(target, text);
    },

    sessions: {},
  };
});

export function selectSession(
  state: AgentStoreState,
  target: AgentTarget
): AgentSession {
  return state.sessions[keyOf(target)] ?? EMPTY_SESSION;
}

/**
 * What a worktree's node should show, across every conversation it holds.
 *
 * A branch is busy if any of its conversations is, and wants attention if any
 * of them is waiting on a permission — reading only the first would leave a
 * node looking idle while its second conversation blocks on a question.
 *
 * Takes the sessions record rather than the store so it can be memoised on it.
 * As a selector it would build a fresh object on every call, which never
 * matches the previous one by identity and re-renders the caller forever.
 */
export function worktreeActivity(
  sessions: Record<string, AgentSession>,
  worktreePath: string
): { needsPermission: boolean; running: boolean } {
  let needsPermission = false;
  let running = false;

  for (const [key, session] of Object.entries(sessions)) {
    if (worktreeOfKey(key) !== worktreePath) {
      continue;
    }
    const activity = agentActivity(session);
    needsPermission = needsPermission || activity.needsPermission;
    running = running || activity.running;
  }

  return { needsPermission, running };
}

/** Node-badge derivation; replaces countTasks. */
export function agentActivity(session: AgentSession): {
  needsPermission: boolean;
  running: boolean;
} {
  return {
    needsPermission: session.conversation.items.some(
      (item) => item.kind === "permission" && item.state === "pending"
    ),
    running: session.conversation.activeTurnId !== null,
  };
}
