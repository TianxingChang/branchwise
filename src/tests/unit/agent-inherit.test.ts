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
      kind: "error",
      message: "The agent stream failed.",
    },
    {
      costUsd: null,
      kind: "turn-done",
      stopReason: "error",
      turnId: "t2",
      usage: null,
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
    expect(
      buildBrief([{ kind: "turn-started", turnId: "t1" }], SOURCE)
    ).toBe("");
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
