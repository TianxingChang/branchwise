import { describe, expect, test } from "vitest";
import {
  buildBrief,
  buildHistoryMessages,
  pathMappingNote,
} from "@/lib/agent/inherit";
import type { AgentEvent } from "@/types/agent";

const SOURCE = {
  childWorktree: "/repo.worktrees/feat-child",
  parentLabel: "feat/parent",
  parentWorktree: "/repo.worktrees/feat-parent",
};

function transcript(): AgentEvent[] {
  return [
    { kind: "user-message", text: "Add retry logic to the sync engine." },
    { kind: "turn-started", turnId: "t1" },
    {
      detail: "/repo.worktrees/feat-parent/src/sync/engine.ts",
      kind: "tool-started",
      name: "Read",
      toolId: "tu1",
    },
    { detail: "", kind: "tool-finished", ok: true, toolId: "tu1" },
    {
      detail: "npm test",
      kind: "tool-started",
      name: "Bash",
      toolId: "tu2",
    },
    { detail: "", kind: "tool-finished", ok: true, toolId: "tu2" },
    {
      kind: "text-delta",
      text: "Added exponential backoff in engine.ts; ",
    },
    { kind: "text-delta", text: "tests pass." },
    {
      costUsd: 0.1,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "t1",
      usage: null,
    },
    { kind: "user-message", text: "Now cap retries at five." },
    { kind: "turn-started", turnId: "t2" },
    {
      costUsd: null,
      kind: "turn-done",
      stopReason: "error",
      turnId: "t2",
      usage: null,
    },
    {
      kind: "error",
      message: "The agent stream failed.",
    },
  ];
}

describe("buildBrief", () => {
  test("digests goal, decisions, repo-relative files and open items", () => {
    const brief = buildBrief(transcript(), SOURCE);
    expect(brief).toContain("Add retry logic to the sync engine.");
    expect(brief).toContain("Added exponential backoff in engine.ts");
    expect(brief).toContain("src/sync/engine.ts");
    expect(brief).not.toContain("/repo.worktrees/feat-parent/src");
    expect(brief).toContain("The agent stream failed.");
    expect(brief).toContain("feat/parent");
  });

  test("a transcript with no user message digests to nothing", () => {
    expect(buildBrief([{ kind: "turn-started", turnId: "t1" }], SOURCE)).toBe(
      ""
    );
  });

  test("an approved permission never appears in 未决事项", () => {
    // Regression: permission-resolved with approved:true should not appear in open items
    const events: AgentEvent[] = [
      { kind: "user-message", text: "Run tests." },
      { kind: "turn-started", turnId: "t1" },
      {
        detail: "npm test",
        kind: "permission-request",
        requestId: "r1",
        toolName: "Bash",
      },
      {
        approved: true,
        kind: "permission-resolved",
        requestId: "r1",
      },
      {
        costUsd: 0.1,
        kind: "turn-done",
        stopReason: "completed",
        turnId: "t1",
        usage: null,
      },
    ];
    const brief = buildBrief(events, SOURCE);
    expect(brief).not.toContain("Bash");
    expect(brief).not.toContain("未决事项");
  });

  test("error before successful turn-done does not appear, but error after last turn-done does", () => {
    // Regression: errors only count if they come after the last turn-done
    const events: AgentEvent[] = [
      { kind: "user-message", text: "Do something." },
      { kind: "turn-started", turnId: "t1" },
      {
        kind: "error",
        message: "Error in turn 1",
      },
      {
        costUsd: 0.1,
        kind: "turn-done",
        stopReason: "error",
        turnId: "t1",
        usage: null,
      },
      { kind: "user-message", text: "Try again." },
      { kind: "turn-started", turnId: "t2" },
      {
        kind: "text-delta",
        text: "Success.",
      },
      {
        costUsd: 0.1,
        kind: "turn-done",
        stopReason: "completed",
        turnId: "t2",
        usage: null,
      },
      {
        kind: "error",
        message: "Error after final turn",
      },
    ];
    const brief = buildBrief(events, SOURCE);
    expect(brief).not.toContain("Error in turn 1");
    expect(brief).toContain("Error after final turn");
  });

  test("an unresolved permission-request anywhere yields a 未决事项 entry", () => {
    // Regression: unresolved permission-request should appear regardless of position
    const events: AgentEvent[] = [
      { kind: "user-message", text: "Do work." },
      { kind: "turn-started", turnId: "t1" },
      {
        detail: "/some/file",
        kind: "permission-request",
        requestId: "r1",
        toolName: "Read",
      },
      {
        kind: "text-delta",
        text: "Working.",
      },
      {
        costUsd: 0.1,
        kind: "turn-done",
        stopReason: "completed",
        turnId: "t1",
        usage: null,
      },
    ];
    const brief = buildBrief(events, SOURCE);
    expect(brief).toContain("未决事项");
    expect(brief).toContain("Read");
  });

  test("strips parent-absolute paths from every section, not just touched files", () => {
    // Final-review A2: only collectTouchedFiles rewrote paths; 任务目标/
    // 近期结论/未决事项 copy model prose verbatim, and prose naming an
    // absolute parent path is the common case. One occurrence per section.
    const events: AgentEvent[] = [
      {
        kind: "user-message",
        text: `Fix the bug in ${SOURCE.parentWorktree}/src/sync/engine.ts.`,
      },
      { kind: "turn-started", turnId: "t1" },
      {
        kind: "text-delta",
        text: `Patched ${SOURCE.parentWorktree}/src/sync/engine.ts.`,
      },
      {
        costUsd: 0.1,
        kind: "turn-done",
        stopReason: "completed",
        turnId: "t1",
        usage: null,
      },
      {
        kind: "error",
        message: `Failed to write ${SOURCE.parentWorktree}/src/sync/engine.ts.`,
      },
    ];
    const brief = buildBrief(events, SOURCE);
    expect(brief).not.toContain(SOURCE.parentWorktree);
    expect(brief).toContain("Fix the bug in src/sync/engine.ts.");
    expect(brief).toContain("Patched src/sync/engine.ts.");
    expect(brief).toContain("Failed to write src/sync/engine.ts.");
  });
});

describe("buildHistoryMessages", () => {
  test("keeps user and non-empty assistant texts in order, drops the rest", () => {
    expect(buildHistoryMessages(transcript())).toEqual([
      { role: "user", text: "Add retry logic to the sync engine." },
      {
        role: "assistant",
        text: "Added exponential backoff in engine.ts; tests pass.",
      },
      { role: "user", text: "Now cap retries at five." },
    ]);
  });
});

describe("pathMappingNote", () => {
  test("names both roots so the agent can map stale paths", () => {
    const note = pathMappingNote(SOURCE);
    expect(note).toContain("/repo.worktrees/feat-parent");
    expect(note).toContain("/repo.worktrees/feat-child");
  });
});
