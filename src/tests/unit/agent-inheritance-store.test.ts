import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { PendingInheritance } from "@/ipc/agent/inheritance";
import {
  clearPendingInheritance,
  readPendingInheritance,
  writePendingInheritance,
} from "@/ipc/agent/inheritance";
import { loadRegistry, saveRegistry } from "@/ipc/agent/registry";
import { worktreeHash } from "@/ipc/agent/transcript";

let base = "";
beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "bw-inheritance-"));
});
afterEach(async () => {
  await rm(base, { force: true, recursive: true });
});

describe("pending inheritance store", () => {
  test("round-trip write and read", async () => {
    const pending: PendingInheritance = {
      brief: "Summarized session",
      mode: "brief",
      note: "test inheritance",
      parentSessionId: "sess_1",
      parentWorktree: "/parent/wt",
    };
    await writePendingInheritance(base, "/child/wt", pending);
    const read = await readPendingInheritance(base, "/child/wt");
    expect(read).toEqual(pending);
  });

  test("missing file returns null", async () => {
    const read = await readPendingInheritance(base, "/child/wt");
    expect(read).toBeNull();
  });

  test("corrupt file returns null and leaves bytes untouched", async () => {
    const childWt = "/child/wt";
    const hash = worktreeHash(childWt);
    const corruptFile = path.join(base, `inherit-${hash}.json`);
    await writeFile(corruptFile, "{not json", "utf8");
    const read = await readPendingInheritance(base, childWt);
    expect(read).toBeNull();
    const raw = await readFile(corruptFile, "utf8");
    expect(raw).toBe("{not json");
  });

  test("clear is idempotent", async () => {
    const pending: PendingInheritance = {
      history: [{ role: "user", text: "hello" }],
      mode: "full",
      note: "test",
      parentWorktree: "/parent/wt",
    };
    await writePendingInheritance(base, "/child/wt", pending);
    await clearPendingInheritance(base, "/child/wt");
    const read = await readPendingInheritance(base, "/child/wt");
    expect(read).toBeNull();
    // Should not throw on second clear
    await clearPendingInheritance(base, "/child/wt");
    const readAgain = await readPendingInheritance(base, "/child/wt");
    expect(readAgain).toBeNull();
  });

  test("registry accepts and preserves inherited field", async () => {
    const registry = await loadRegistry(base);
    registry.worktrees["/wt/a"] = {
      driverId: "codex",
      inherited: {
        at: 1000,
        from: "/parent/wt",
        mode: "brief",
      },
      sessionId: null,
      threadId: "th_1",
      tier: "accept-edits",
      updatedAt: 111,
    };
    await saveRegistry(base, registry);
    const loaded = await loadRegistry(base);
    expect(loaded.worktrees["/wt/a"].inherited).toEqual({
      at: 1000,
      from: "/parent/wt",
      mode: "brief",
    });
  });

  test("registry accepts entries without inherited field", async () => {
    const registry = await loadRegistry(base);
    registry.worktrees["/wt/b"] = {
      driverId: "codex",
      sessionId: null,
      threadId: "th_1",
      tier: "accept-edits",
      updatedAt: 222,
    };
    await saveRegistry(base, registry);
    const loaded = await loadRegistry(base);
    expect(loaded.worktrees["/wt/b"]).toBeDefined();
    expect(loaded.worktrees["/wt/b"].inherited).toBeUndefined();
  });
});
