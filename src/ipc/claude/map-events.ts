import type { AgentEvent } from "@/types/agent";

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return value !== null && typeof value === "object" ? (value as Rec) : null;
}

/** One line of human-readable context for a tool call, vendor payload stays here. */
function toolDetail(_name: unknown, input: unknown): string {
  const fields = rec(input);
  if (!fields) {
    return "";
  }
  const keys = ["command", "file_path", "path", "pattern", "url", "query"];
  for (const key of keys) {
    const value = fields[key];
    if (typeof value === "string" && value.length > 0) {
      return value.length > 200 ? `${value.slice(0, 200)}…` : value;
    }
  }
  const json = JSON.stringify(fields);
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
}

function resultText(content: unknown): string {
  if (typeof content === "string") {
    return content.length > 200 ? `${content.slice(0, 200)}…` : content;
  }
  return "";
}

function mapStreamEvent(m: Rec): AgentEvent[] {
  const event = rec(m.event);
  const delta = rec(event?.delta);
  if (event?.type !== "content_block_delta" || !delta) {
    return [];
  }
  if (delta.type === "text_delta" && typeof delta.text === "string") {
    return [{ kind: "text-delta", text: delta.text }];
  }
  if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
    return [{ kind: "thinking-delta", text: delta.thinking }];
  }
  return [];
}

function mapMessageBlocks(m: Rec): AgentEvent[] {
  const content = rec(m.message)?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  const events: AgentEvent[] = [];
  for (const block of content) {
    const b = rec(block);
    if (!b) {
      continue;
    }
    if (b.type === "tool_use" && typeof b.id === "string") {
      events.push({
        detail: toolDetail(b.name, b.input),
        kind: "tool-started",
        name: typeof b.name === "string" ? b.name : "tool",
        toolId: b.id,
      });
    }
    if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
      events.push({
        detail: resultText(b.content),
        kind: "tool-finished",
        ok: b.is_error !== true,
        toolId: b.tool_use_id,
      });
    }
  }
  return events;
}

function mapResult(m: Rec, turnId: string): AgentEvent[] {
  const usage = rec(m.usage);
  return [
    {
      costUsd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : null,
      kind: "turn-done",
      stopReason: m.subtype === "success" ? "completed" : "error",
      turnId,
      usage: usage
        ? {
            inputTokens:
              typeof usage.input_tokens === "number"
                ? usage.input_tokens
                : null,
            outputTokens:
              typeof usage.output_tokens === "number"
                ? usage.output_tokens
                : null,
          }
        : null,
    },
  ];
}

/**
 * Normalises one SDK message into branchwise events. Structural on purpose:
 * matching on shapes rather than imported SDK types keeps the vendor boundary
 * at the adapter and makes fixtures the complete spec of this function.
 */
export function mapClaudeMessage(
  message: unknown,
  turnId: string
): AgentEvent[] {
  const m = rec(message);
  if (!m) {
    return [];
  }

  if (m.type === "stream_event") {
    return mapStreamEvent(m);
  }

  if (m.type === "assistant" || m.type === "user") {
    return mapMessageBlocks(m);
  }

  if (m.type === "result") {
    return mapResult(m, turnId);
  }

  return [];
}
