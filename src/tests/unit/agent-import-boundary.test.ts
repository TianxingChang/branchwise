import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

const FORBIDDEN = [
  "@anthropic-ai/claude-agent-sdk",
  "@/ipc/claude/",
  "@/ipc/codex/",
];

const TS_EXTENSION = /\.(ts|tsx)$/;

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return await sourceFiles(full);
      }
      return TS_EXTENSION.test(entry.name) ? [full] : [];
    })
  );
  return nested.flat();
}

describe("vendor import boundary (atlas A1)", () => {
  test("stores and components never import vendor modules", async () => {
    const roots = ["src/stores", "src/components"].map((p) =>
      path.resolve(process.cwd(), p)
    );
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    const sources = await Promise.all(
      files.map(async (file) => ({
        file,
        source: await readFile(file, "utf8"),
      }))
    );
    for (const { file, source } of sources) {
      for (const forbidden of FORBIDDEN) {
        expect(source.includes(forbidden), `${file} imports ${forbidden}`).toBe(
          false
        );
      }
    }
  });
});
