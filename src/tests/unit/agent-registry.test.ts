import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadRegistry, saveRegistry } from "@/ipc/agent/registry";

let base = "";
beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "bw-registry-"));
});
afterEach(async () => {
  await rm(base, { force: true, recursive: true });
});

describe("agent registry", () => {
  test("missing file loads as an empty registry", async () => {
    const registry = await loadRegistry(base);
    expect(registry).toEqual({
      lastDriverId: "claude-code",
      version: 1,
      worktrees: {},
    });
  });

  test("round-trips and writes atomically (no partial file left behind)", async () => {
    const registry = await loadRegistry(base);
    registry.worktrees["/wt/a"] = {
      driverId: "codex",
      sessionId: null,
      threadId: "th_1",
      tier: "accept-edits",
      updatedAt: 111,
    };
    registry.lastDriverId = "codex";
    await saveRegistry(base, registry);
    expect(await loadRegistry(base)).toEqual(registry);
    const raw = await readFile(path.join(base, "registry.json"), "utf8");
    expect(JSON.parse(raw).version).toBe(1);
  });

  test("a corrupt file loads as empty rather than throwing (and is not overwritten until save)", async () => {
    const file = path.join(base, "registry.json");
    await writeFile(file, "{not json", "utf8");
    expect(await loadRegistry(base)).toEqual({
      lastDriverId: "claude-code",
      version: 1,
      worktrees: {},
    });
    // Load alone must not clobber the unreadable file (F5 lesson: an
    // unreadable file must not become a deleted file).
    expect(await readFile(file, "utf8")).toBe("{not json");
  });
});
