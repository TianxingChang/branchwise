import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  appendTranscript,
  readTranscript,
  worktreeHash,
} from "@/ipc/agent/transcript";
import type { AgentEvent } from "@/types/agent";

let base = "";
beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "bw-transcript-"));
});
afterEach(async () => {
  await rm(base, { force: true, recursive: true });
});

const WT = "/tmp/repo.worktrees/feat-a";

describe("transcript", () => {
  test("hash is stable and filename-safe", () => {
    expect(worktreeHash(WT)).toBe(worktreeHash(WT));
    expect(worktreeHash(WT)).toMatch(/^[a-f0-9]{16}$/);
    expect(worktreeHash("/other")).not.toBe(worktreeHash(WT));
  });

  test("appends then reads back in order", async () => {
    const events: AgentEvent[] = [
      { kind: "user-message", text: "one" },
      { kind: "turn-started", turnId: "t1" },
      {
        costUsd: null,
        kind: "turn-done",
        stopReason: "completed",
        turnId: "t1",
        usage: null,
      },
    ];
    for (const event of events) {
      await appendTranscript(base, WT, event);
    }
    expect(await readTranscript(base, WT)).toEqual(events);
  });

  test("tolerates a torn final line", async () => {
    await appendTranscript(base, WT, { kind: "user-message", text: "ok" });
    const file = path.join(base, "transcripts", `${worktreeHash(WT)}.ndjson`);
    await appendFile(file, '{"at":123,"event":{"kind":"text-de', "utf8");
    expect(await readTranscript(base, WT)).toEqual([
      { kind: "user-message", text: "ok" },
    ]);
  });

  test("missing transcript reads as empty", async () => {
    expect(await readTranscript(base, "/never/seen")).toEqual([]);
  });

  test("limit keeps only the newest events", async () => {
    for (let i = 0; i < 5; i += 1) {
      await appendTranscript(base, WT, { kind: "user-message", text: `${i}` });
    }
    const events = await readTranscript(base, WT, 2);
    expect(events).toEqual([
      { kind: "user-message", text: "3" },
      { kind: "user-message", text: "4" },
    ]);
  });
});
