import { describe, expect, test } from "vitest";
import { agentEventSchema } from "@/types/agent";

describe("agentEventSchema", () => {
  test("parses every event kind", () => {
    const events = [
      { kind: "user-message", text: "do the thing" },
      { kind: "turn-started", turnId: "t1" },
      { kind: "text-delta", text: "hel" },
      { kind: "thinking-delta", text: "hmm" },
      { detail: "npm test", kind: "tool-started", name: "Bash", toolId: "u1" },
      { detail: "153 passed", kind: "tool-finished", ok: true, toolId: "u1" },
      {
        detail: "rm -rf node_modules",
        kind: "permission-request",
        requestId: "r1",
        toolName: "Bash",
      },
      { approved: false, kind: "permission-resolved", requestId: "r1" },
      {
        costUsd: 0.42,
        kind: "turn-done",
        stopReason: "completed",
        turnId: "t1",
        usage: { inputTokens: 1200, outputTokens: 340 },
      },
      { kind: "error", message: "codex is not installed" },
    ];
    for (const event of events) {
      expect(agentEventSchema.parse(event)).toEqual(event);
    }
  });

  test("rejects an unknown kind", () => {
    expect(() => agentEventSchema.parse({ kind: "nope" })).toThrow();
  });
});
