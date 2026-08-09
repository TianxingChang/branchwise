import { describe, expect, test } from "vitest";
import { mapClaudeMessage } from "@/ipc/claude/map-events";

describe("mapClaudeMessage", () => {
  test("text and thinking deltas", () => {
    const message = {
      event: {
        delta: { text: "hel", type: "text_delta" },
        type: "content_block_delta",
      },
      session_id: "s1",
      type: "stream_event",
    };
    expect(mapClaudeMessage(message, "t1")).toEqual([
      { kind: "text-delta", text: "hel" },
    ]);
    const thinking = {
      event: {
        delta: { thinking: "hmm", type: "thinking_delta" },
        type: "content_block_delta",
      },
      type: "stream_event",
    };
    expect(mapClaudeMessage(thinking, "t1")).toEqual([
      { kind: "thinking-delta", text: "hmm" },
    ]);
  });

  test("assistant tool_use becomes tool-started with a one-line detail", () => {
    const message = {
      message: {
        content: [
          {
            id: "toolu_1",
            input: { command: "npm test" },
            name: "Bash",
            type: "tool_use",
          },
        ],
      },
      type: "assistant",
    };
    expect(mapClaudeMessage(message, "t1")).toEqual([
      {
        detail: "npm test",
        kind: "tool-started",
        name: "Bash",
        toolId: "toolu_1",
      },
    ]);
  });

  test("user tool_result becomes tool-finished, error flag respected", () => {
    const message = {
      message: {
        content: [
          {
            content: "boom",
            is_error: true,
            tool_use_id: "toolu_1",
            type: "tool_result",
          },
        ],
      },
      type: "user",
    };
    expect(mapClaudeMessage(message, "t1")).toEqual([
      { detail: "boom", kind: "tool-finished", ok: false, toolId: "toolu_1" },
    ]);
  });

  test("result carries cost and usage into turn-done", () => {
    const message = {
      subtype: "success",
      total_cost_usd: 0.37,
      type: "result",
      usage: { input_tokens: 1200, output_tokens: 88 },
    };
    expect(mapClaudeMessage(message, "t9")).toEqual([
      {
        costUsd: 0.37,
        kind: "turn-done",
        stopReason: "completed",
        turnId: "t9",
        usage: { inputTokens: 1200, outputTokens: 88 },
      },
    ]);
  });

  test("error result maps to error stop reason", () => {
    const message = { subtype: "error_during_execution", type: "result" };
    expect(mapClaudeMessage(message, "t9")).toEqual([
      {
        costUsd: null,
        kind: "turn-done",
        stopReason: "error",
        turnId: "t9",
        usage: null,
      },
    ]);
  });

  test("unknown message types map to nothing", () => {
    expect(mapClaudeMessage({ type: "status" }, "t1")).toEqual([]);
    expect(mapClaudeMessage(null, "t1")).toEqual([]);
    expect(mapClaudeMessage("garbage", "t1")).toEqual([]);
  });
});
