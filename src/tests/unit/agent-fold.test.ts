import { describe, expect, test } from "vitest";
import { emptyConversation, foldEvent } from "@/lib/agent/fold";
import type { AgentEvent } from "@/types/agent";

function foldAll(events: AgentEvent[]) {
  return events.reduce(foldEvent, emptyConversation());
}

describe("foldEvent", () => {
  test("commits a whole assistant message only at turn-done", () => {
    const mid = foldAll([
      { kind: "user-message", text: "hi" },
      { kind: "turn-started", turnId: "t1" },
      { kind: "text-delta", text: "he" },
      { kind: "text-delta", text: "llo" },
    ]);
    // Streaming text is buffered, not an item (A4-lite).
    expect(mid.items).toHaveLength(1);
    expect(mid.items[0]).toMatchObject({ kind: "user", text: "hi" });
    expect(mid.streamingText).toBe("hello");
    expect(mid.activeTurnId).toBe("t1");

    const done = foldEvent(mid, {
      costUsd: 0.1,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "t1",
      usage: null,
    });
    expect(done.items).toHaveLength(2);
    expect(done.items[1]).toMatchObject({
      costUsd: 0.1,
      kind: "assistant",
      text: "hello",
    });
    expect(done.streamingText).toBe("");
    expect(done.activeTurnId).toBeNull();
  });

  test("tool and permission items are whole items updated in place", () => {
    const state = foldAll([
      { kind: "turn-started", turnId: "t1" },
      { detail: "ls", kind: "tool-started", name: "Bash", toolId: "u1" },
      {
        detail: "src/a.ts",
        kind: "permission-request",
        requestId: "r1",
        toolName: "Write",
      },
      { approved: true, kind: "permission-resolved", requestId: "r1" },
      { detail: "exit 1", kind: "tool-finished", ok: false, toolId: "u1" },
    ]);
    expect(state.items).toMatchObject([
      { detail: "ls", kind: "tool", name: "Bash", state: "error" },
      { kind: "permission", requestId: "r1", state: "approved" },
    ]);
  });

  test("interrupted turn with buffered text still commits the partial message", () => {
    const state = foldAll([
      { kind: "turn-started", turnId: "t1" },
      { kind: "text-delta", text: "half a thou" },
      {
        costUsd: null,
        kind: "turn-done",
        stopReason: "interrupted",
        turnId: "t1",
        usage: null,
      },
    ]);
    expect(state.items.at(-1)).toMatchObject({
      kind: "assistant",
      text: "half a thou",
    });
    expect(state.items.at(-1)).toHaveProperty("interrupted", true);
  });

  test("error event becomes a notice item", () => {
    const state = foldAll([{ kind: "error", message: "spawn failed" }]);
    expect(state.items[0]).toMatchObject({
      kind: "notice",
      text: "spawn failed",
    });
  });

  test("ids are deterministic so transcript replay reproduces identical items", () => {
    const events: AgentEvent[] = [
      { kind: "user-message", text: "a" },
      { kind: "turn-started", turnId: "t1" },
      { kind: "text-delta", text: "b" },
      {
        costUsd: null,
        kind: "turn-done",
        stopReason: "completed",
        turnId: "t1",
        usage: null,
      },
    ];
    expect(foldAll(events)).toEqual(foldAll(events));
  });
});
