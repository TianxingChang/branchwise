import type { AgentEvent } from "@/types/agent";

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return value !== null && typeof value === "object" ? (value as Rec) : null;
}

export function clip(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  // One-line contract for detail fields: collapse newlines before capping.
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

function itemName(item: Rec): string {
  switch (item.type) {
    case "commandExecution":
      return "shell";
    case "fileChange":
      return "file_change";
    case "webSearch":
      return "web_search";
    case "mcpToolCall":
    case "dynamicToolCall":
      return typeof item.tool === "string" ? item.tool : "tool";
    default:
      return typeof item.type === "string" ? item.type : "tool";
  }
}

function itemDetail(item: Rec): string {
  return clip(item.command) || clip(item.path) || clip(item.query) || "";
}

function mapItemStarted(item: Rec | null): AgentEvent[] {
  if (!item || item.type === "agentMessage" || item.type === "reasoning") {
    return [];
  }
  return typeof item.id === "string"
    ? [
        {
          detail: itemDetail(item),
          kind: "tool-started",
          name: itemName(item),
          toolId: item.id,
        },
      ]
    : [];
}

function mapItemCompleted(item: Rec | null): AgentEvent[] {
  if (!item || item.type === "agentMessage" || item.type === "reasoning") {
    return [];
  }
  return typeof item.id === "string"
    ? [
        {
          detail: clip(item.error) || "",
          kind: "tool-finished",
          ok: item.status !== "failed",
          toolId: item.id,
        },
      ]
    : [];
}

function buildUsage(
  usage: Rec | null
): { inputTokens: number | null; outputTokens: number | null } | null {
  if (!usage) {
    return null;
  }
  return {
    inputTokens:
      typeof usage.inputTokens === "number" ? usage.inputTokens : null,
    outputTokens:
      typeof usage.outputTokens === "number" ? usage.outputTokens : null,
  };
}

function mapTurnCompleted(
  turn: Rec | null,
  context: { turnId: string }
): AgentEvent[] {
  const failed = turn?.status === "failed";
  const events: AgentEvent[] = [];
  if (failed) {
    events.push({ kind: "error", message: "The codex turn failed." });
  }
  events.push({
    costUsd: null,
    kind: "turn-done",
    stopReason: failed ? "error" : "completed",
    turnId: context.turnId,
    usage: buildUsage(rec(turn?.usage)),
  });
  return events;
}

/**
 * Normalises one codex app-server notification into branchwise events.
 * Anything addressed to a different thread is dropped here — the one place
 * cross-thread leakage is possible.
 */
export function mapCodexNotification(
  method: string,
  params: unknown,
  context: { threadId: string; turnId: string }
): AgentEvent[] {
  const p = rec(params);
  if (!p) {
    return [];
  }
  if (typeof p.threadId === "string" && p.threadId !== context.threadId) {
    return [];
  }

  switch (method) {
    case "item/agentMessage/delta":
      return typeof p.delta === "string"
        ? [{ kind: "text-delta", text: p.delta }]
        : [];

    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta":
      return typeof p.delta === "string"
        ? [{ kind: "thinking-delta", text: p.delta }]
        : [];

    case "item/started":
      return mapItemStarted(rec(p.item));

    case "item/completed":
      return mapItemCompleted(rec(p.item));

    case "turn/completed":
      return mapTurnCompleted(rec(p.turn), context);

    case "error":
      return [
        {
          kind: "error",
          message: clip(p.message) || "codex reported an error.",
        },
      ];

    default:
      return [];
  }
}
