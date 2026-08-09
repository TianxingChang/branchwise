import { create } from "zustand";
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
import type { AgentConfig, AgentEvent } from "@/types/agent";

export interface AgentSession {
  attached: boolean;
  config: AgentConfig | null;
  conversation: ConversationState;
  hasConversation: boolean;
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
  close: (worktreePath: string) => void;
  configure: (worktreePath: string, config: AgentConfig) => Promise<void>;
  interrupt: (worktreePath: string) => Promise<void>;
  open: (worktreePath: string) => Promise<void>;
  reset: () => void;
  respond: (
    worktreePath: string,
    requestId: string,
    approved: boolean
  ) => Promise<void>;
  sendMessage: (worktreePath: string, text: string) => Promise<void>;
  sessions: Record<string, AgentSession>;
}

const controllers = new Map<string, AbortController>();

export const useAgentStore = create<AgentStoreState>()((set) => {
  function patch(
    worktreePath: string,
    update: (session: AgentSession) => AgentSession
  ): void {
    set((state) => ({
      sessions: {
        ...state.sessions,
        [worktreePath]: update(state.sessions[worktreePath] ?? EMPTY_SESSION),
      },
    }));
  }

  return {
    close: (worktreePath) => {
      controllers.get(worktreePath)?.abort();
      controllers.delete(worktreePath);
      patch(worktreePath, (session) => ({ ...session, attached: false }));
    },

    configure: async (worktreePath, config) => {
      await actions.setAgentConfig(worktreePath, config);
      patch(worktreePath, (session) => ({ ...session, config }));
    },

    interrupt: async (worktreePath) => {
      await actions.interruptAgent(worktreePath);
    },

    open: async (worktreePath) => {
      controllers.get(worktreePath)?.abort();
      const controller = new AbortController();
      controllers.set(worktreePath, controller);

      const [meta, history] = await Promise.all([
        actions.getAgentConfig(worktreePath),
        actions.agentHistory(worktreePath),
      ]);
      const folded = trimToLastTurnDone(history).reduce(
        foldEvent,
        emptyConversation()
      );
      patch(worktreePath, () => ({
        attached: true,
        config: meta.config,
        conversation: folded,
        hasConversation: meta.hasConversation,
      }));

      const stream = await actions.attachAgent(worktreePath, controller.signal);
      (async () => {
        try {
          for await (const event of stream) {
            if (controller.signal.aborted) {
              return;
            }
            patch(worktreePath, (session) => ({
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

    respond: async (worktreePath, requestId, approved) => {
      await actions.respondAgentPermission({
        approved,
        requestId,
        worktreePath,
      });
    },

    sendMessage: async (worktreePath, text) => {
      await actions.sendAgentMessage(worktreePath, text);
    },

    sessions: {},
  };
});

export function selectSession(
  state: AgentStoreState,
  worktreePath: string
): AgentSession {
  return state.sessions[worktreePath] ?? EMPTY_SESSION;
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
