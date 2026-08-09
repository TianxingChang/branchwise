import { afterEach, describe, expect, test } from "vitest";
import { highlightCodeLines, resetHighlighter } from "@/lib/files/shiki";

afterEach(() => {
  resetHighlighter();
});

describe("highlightCodeLines", () => {
  test("returns one markup string per input line", async () => {
    const lines = await highlightCodeLines(
      "const a = 1;\nlet b = 2;",
      "typescript"
    );

    expect(lines).toHaveLength(2);
    expect(lines?.[0]).toContain("<span");
    expect(lines?.[0]).toContain("const");
    expect(lines?.[1]).toContain("let");
  });

  test("returns null for plain text, which needs no markup", async () => {
    expect(await highlightCodeLines("just words", "text")).toBeNull();
  });
});
