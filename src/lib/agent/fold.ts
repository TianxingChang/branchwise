import type { AgentEvent, AgentUsage } from "@/types/agent";

export type ConversationItem =
  | { id: string; kind: "user"; text: string }
  | {
      costUsd: number | null;
      id: string;
      interrupted: boolean;
      kind: "assistant";
      text: string;
      thinking: string;
      usage: AgentUsage | null;
    }
  | {
      detail: string;
      id: string;
      kind: "tool";
      name: string;
      state: "running" | "ok" | "error";
      result: string;
    }
  | {
      detail: string;
      id: string;
      kind: "permission";
      requestId: string;
      state: "pending" | "approved" | "denied";
      toolName: string;
    }
  | { id: string; kind: "notice"; text: string };

export interface ConversationState {
  activeTurnId: string | null;
  items: ConversationItem[];
  /** Monotonic counter so replaying the same events yields the same ids. */
  seq: number;
  streamingText: string;
  streamingThinking: string;
}

export function emptyConversation(): ConversationState {
  return {
    activeTurnId: null,
    items: [],
    seq: 0,
    streamingText: "",
    streamingThinking: "",
  };
}

function withItem(
  state: ConversationState,
  item: ConversationItem
): ConversationState {
  return { ...state, items: [...state.items, item], seq: state.seq + 1 };
}

function updateItem(
  state: ConversationState,
  match: (item: ConversationItem) => boolean,
  update: (item: ConversationItem) => ConversationItem
): ConversationState {
  return {
    ...state,
    items: state.items.map((item) => (match(item) ? update(item) : item)),
  };
}

/**
 * Folds one AgentEvent into conversation state. Pure and deterministic: the
 * live stream and the persisted transcript run through the same function, so
 * a restart rebuilds exactly what the user was looking at. Streaming text
 * stays out of `items` until turn-done (A4-lite: items grow only by whole
 * messages).
 */
export function foldEvent(
  state: ConversationState,
  event: AgentEvent
): ConversationState {
  switch (event.kind) {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Exhaustive union match
    case "user-message":
      return withItem(state, {
        id: `i${state.seq}`,
        kind: "user",
        text: event.text,
      });

    // biome-ignore lint/suspicious/noUnnecessaryConditions: Exhaustive union match
    case "turn-started":
      return {
        ...state,
        activeTurnId: event.turnId,
        streamingText: "",
        streamingThinking: "",
      };

    // biome-ignore lint/suspicious/noUnnecessaryConditions: Exhaustive union match
    case "text-delta":
      return { ...state, streamingText: state.streamingText + event.text };

    // biome-ignore lint/suspicious/noUnnecessaryConditions: Exhaustive union match
    case "thinking-delta":
      return {
        ...state,
        streamingThinking: state.streamingThinking + event.text,
      };

    // biome-ignore lint/suspicious/noUnnecessaryConditions: Exhaustive union match
    case "tool-started":
      return withItem(state, {
        detail: event.detail,
        id: `tool-${event.toolId}`,
        kind: "tool",
        name: event.name,
        result: "",
        state: "running",
      });

    // biome-ignore lint/suspicious/noUnnecessaryConditions: Exhaustive union match
    case "tool-finished":
      return updateItem(
        state,
        (item) => item.kind === "tool" && item.id === `tool-${event.toolId}`,
        (item) =>
          item.kind === "tool"
            ? {
                ...item,
                result: event.detail,
                state: event.ok ? "ok" : "error",
              }
            : item
      );

    // biome-ignore lint/suspicious/noUnnecessaryConditions: Exhaustive union match
    case "permission-request":
      return withItem(state, {
        detail: event.detail,
        id: `perm-${event.requestId}`,
        kind: "permission",
        requestId: event.requestId,
        state: "pending",
        toolName: event.toolName,
      });

    // biome-ignore lint/suspicious/noUnnecessaryConditions: Exhaustive union match
    case "permission-resolved":
      return updateItem(
        state,
        (item) =>
          item.kind === "permission" && item.requestId === event.requestId,
        (item) =>
          item.kind === "permission"
            ? { ...item, state: event.approved ? "approved" : "denied" }
            : item
      );

    // biome-ignore lint/suspicious/noUnnecessaryConditions: Exhaustive union match
    case "turn-done": {
      const flushed =
        state.streamingText.length > 0 || state.streamingThinking.length > 0
          ? withItem(state, {
              costUsd: event.costUsd,
              id: `turn-${event.turnId}`,
              interrupted: event.stopReason === "interrupted",
              kind: "assistant",
              text: state.streamingText,
              thinking: state.streamingThinking,
              usage: event.usage,
            })
          : state;
      return {
        ...flushed,
        activeTurnId: null,
        streamingText: "",
        streamingThinking: "",
      };
    }

    // biome-ignore lint/suspicious/noUnnecessaryConditions: Exhaustive union match
    case "error":
      return withItem(state, {
        id: `i${state.seq}`,
        kind: "notice",
        text: event.message,
      });

    default:
      return state;
  }
}
