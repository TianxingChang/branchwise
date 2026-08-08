import { create } from "zustand";

export type AgentTaskStatus = "queued" | "running" | "done";

export interface AgentMessage {
  id: string;
  kind: "message";
  role: "assistant" | "user";
  text: string;
}

export interface AgentTask {
  agent: string;
  description: string;
  id: string;
  kind: "task";
  status: AgentTaskStatus;
}

export type ConversationItem = AgentMessage | AgentTask;

interface Conversation {
  items: ConversationItem[];
  thinking: boolean;
}

interface AgentStoreState {
  clear: (key: string) => void;
  conversations: Record<string, Conversation>;
  send: (key: string, branchName: string, text: string) => void;
}

const EMPTY: Conversation = { items: [], thinking: false };

/**
 * Canned responses. The shape of the exchange — a short plan, then a task card
 * that moves through its states — is what the real agent will produce, so the
 * panel can be tuned against it before any of it is wired up.
 */
const REPLIES: { agent: string; reply: string; task: string }[] = [
  {
    agent: "Planner Agent",
    reply:
      "Reading the tree on {branch} first — I want to see what already exists before proposing changes. I'll come back with a short plan and the files I expect to touch.",
    task: "Mapping the module graph and entry points",
  },
  {
    agent: "Implementer Agent",
    reply:
      "Working this on {branch} so nothing lands on main until you've seen it. I'll keep the change surface small and report every file I edit.",
    task: "Drafting the change set",
  },
  {
    agent: "Review Agent",
    reply:
      "I'll diff {branch} against its parent and flag anything that looks unintended — dead code, missed call sites, tests that no longer cover the path.",
    task: "Reviewing the diff against the parent branch",
  },
  {
    agent: "Test Agent",
    reply:
      "Running the suite on {branch}. If something fails I'll fix it and re-run rather than handing you a red build.",
    task: "Running the test suite",
  },
];

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36)}`;
}

export const useAgentStore = create<AgentStoreState>()((set, get) => {
  function patch(key: string, update: (conv: Conversation) => Conversation) {
    set((state) => ({
      conversations: {
        ...state.conversations,
        [key]: update(state.conversations[key] ?? EMPTY),
      },
    }));
  }

  function setTaskStatus(key: string, taskId: string, status: AgentTaskStatus) {
    patch(key, (conv) => ({
      ...conv,
      items: conv.items.map((item) =>
        item.kind === "task" && item.id === taskId ? { ...item, status } : item
      ),
    }));
  }

  return {
    clear: (key) => patch(key, () => ({ items: [], thinking: false })),

    conversations: {},

    send: (key, branchName, text) => {
      const trimmed = text.trim();
      if (trimmed.length === 0 || get().conversations[key]?.thinking) {
        return;
      }

      patch(key, (conv) => ({
        items: [
          ...conv.items,
          { id: newId("msg"), kind: "message", role: "user", text: trimmed },
        ],
        thinking: true,
      }));

      const turn = get().conversations[key]?.items.length ?? 0;
      const canned = REPLIES[Math.floor(turn / 2) % REPLIES.length];
      const taskId = newId("task");

      setTimeout(() => {
        patch(key, (conv) => ({
          items: [
            ...conv.items,
            {
              id: newId("msg"),
              kind: "message",
              role: "assistant",
              text: canned.reply.replace("{branch}", branchName),
            },
            {
              agent: canned.agent,
              description: canned.task,
              id: taskId,
              kind: "task",
              status: "queued",
            },
          ],
          thinking: false,
        }));
      }, 650);

      setTimeout(() => setTaskStatus(key, taskId, "running"), 1500);
      setTimeout(() => setTaskStatus(key, taskId, "done"), 5200);
    },
  };
});

export interface TaskCounts {
  done: number;
  pending: number;
  running: number;
}

/** Tallies task cards by status. Pure so the node badge can memoize on items. */
export function countTasks(items: ConversationItem[] | undefined): TaskCounts {
  const counts: TaskCounts = { done: 0, pending: 0, running: 0 };
  for (const item of items ?? []) {
    if (item.kind !== "task") {
      continue;
    }
    if (item.status === "done") {
      counts.done += 1;
    } else if (item.status === "running") {
      counts.running += 1;
    } else {
      counts.pending += 1;
    }
  }
  return counts;
}

export function conversationKey(path: string, nodeId: string): string {
  return `${path}::${nodeId}`;
}

export function selectConversation(
  state: AgentStoreState,
  key: string
): Conversation {
  return state.conversations[key] ?? EMPTY;
}
