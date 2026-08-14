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

const noFallback = () => Promise.resolve<string[]>([]);

describe("resolveClaudeExecutable", () => {
  // systemCandidates is [] throughout: the default brew paths are real
  // machine state these tests must not depend on.
  test("CLAUDE_BIN override wins when it exists", async () => {
    const bin = await fakeBinary("claude");
    expect(
      await resolveClaudeExecutable(
        { CLAUDE_BIN: bin, HOME: base, PATH: "" },
        []
      )
    ).toBe(bin);
  });

  test("a CLAUDE_BIN pointing nowhere is ignored, PATH is searched", async () => {
    const bin = await fakeBinary("claude");
    const resolved = await resolveClaudeExecutable(
      { CLAUDE_BIN: path.join(base, "missing"), HOME: base, PATH: base },
      []
    );
    expect(resolved).toBe(bin);
  });

  test("an injected system candidate beats PATH", async () => {
    const system = await fakeBinary("claude");
    const resolved = await resolveClaudeExecutable(
      { HOME: path.join(base, "nohome"), PATH: "" },
      [system]
    );
    expect(resolved).toBe(system);
  });

  test("returns null when nothing is installed", async () => {
    // The login-shell fallback is stubbed out: unstubbed it would spawn the
    // real shell and find whatever this machine has, which is the opposite of
    // what the test is asking.
    expect(
      await resolveClaudeExecutable({ HOME: base, PATH: base }, [], noFallback)
    ).toBeNull();
  });

  test("falls back to the login shell's PATH", async () => {
    // A CLI under a version manager's own prefix is in none of the fixed
    // candidates and not on a Finder-launched app's PATH — but it is on the
    // PATH a terminal would have, which is where the user found it.
    const elsewhere = await fakeBinary("claude");

    expect(
      await resolveClaudeExecutable({ HOME: base, PATH: "" }, [], () =>
        Promise.resolve([path.dirname(elsewhere)])
      )
    ).toBe(elsewhere);
  });
});
