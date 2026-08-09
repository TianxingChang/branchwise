import { describe, expect, test } from "vitest";
import { mapCodexNotification } from "@/ipc/codex/map-events";

const CTX = { threadId: "th_1", turnId: "turn_1" };

describe("mapCodexNotification", () => {
  test("agent message delta", () => {
    expect(
      mapCodexNotification(
        "item/agentMessage/delta",
        { delta: "hey", threadId: "th_1" },
        CTX
      )
    ).toEqual([{ kind: "text-delta", text: "hey" }]);
  });

  test("reasoning deltas map to thinking", () => {
    expect(
      mapCodexNotification(
        "item/reasoning/textDelta",
        { delta: "let me see", threadId: "th_1" },
        CTX
      )
    ).toEqual([{ kind: "thinking-delta", text: "let me see" }]);
  });

  test("command execution item lifecycle", () => {
    expect(
      mapCodexNotification(
        "item/started",
        {
          item: { command: "npm test", id: "it_1", type: "commandExecution" },
          threadId: "th_1",
        },
        CTX
      )
    ).toEqual([
      { detail: "npm test", kind: "tool-started", name: "shell", toolId: "it_1" },
    ]);
    expect(
      mapCodexNotification(
        "item/completed",
        {
          item: { id: "it_1", status: "failed", type: "commandExecution" },
          threadId: "th_1",
        },
        CTX
      )
    ).toEqual([{ detail: "", kind: "tool-finished", ok: false, toolId: "it_1" }]);
  });

  test("turn completion carries usage; failed status is an error", () => {
    expect(
      mapCodexNotification(
        "turn/completed",
        {
          threadId: "th_1",
          turn: {
            status: "completed",
            usage: { inputTokens: 900, outputTokens: 120 },
          },
        },
        CTX
      )
    ).toEqual([
      {
        costUsd: null,
        kind: "turn-done",
        stopReason: "completed",
        turnId: "turn_1",
        usage: { inputTokens: 900, outputTokens: 120 },
      },
    ]);
    const failed = mapCodexNotification(
      "turn/completed",
      { threadId: "th_1", turn: { status: "failed" } },
      CTX
    );
    expect(failed.at(-1)).toMatchObject({ stopReason: "error" });
  });

  test("cross-thread notifications are dropped", () => {
    expect(
      mapCodexNotification(
        "item/agentMessage/delta",
        { delta: "leak", threadId: "th_OTHER" },
        CTX
      )
    ).toEqual([]);
  });

  test("unknown methods map to nothing", () => {
    expect(mapCodexNotification("thread/metadata", {}, CTX)).toEqual([]);
  });
});
