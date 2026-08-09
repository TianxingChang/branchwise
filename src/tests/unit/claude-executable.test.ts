import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveClaudeExecutable } from "@/ipc/claude/executable";

let base = "";
beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "bw-claude-bin-"));
});
afterEach(async () => {
  await rm(base, { force: true, recursive: true });
});

async function fakeBinary(name: string): Promise<string> {
  const file = path.join(base, name);
  await writeFile(file, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(file, 0o755);
  return file;
}

describe("resolveClaudeExecutable", () => {
  test("CLAUDE_BIN override wins when it exists", async () => {
    const bin = await fakeBinary("claude");
    expect(
      await resolveClaudeExecutable({ CLAUDE_BIN: bin, HOME: base, PATH: "" })
    ).toBe(bin);
  });

  test("a CLAUDE_BIN pointing nowhere is ignored, PATH is searched", async () => {
    const bin = await fakeBinary("claude");
    const resolved = await resolveClaudeExecutable({
      CLAUDE_BIN: path.join(base, "missing"),
      HOME: base,
      PATH: base,
    });
    expect(resolved).toBe(bin);
  });

  test("returns null when nothing is installed", async () => {
    expect(
      await resolveClaudeExecutable({ HOME: base, PATH: base })
    ).toBeNull();
  });
});
