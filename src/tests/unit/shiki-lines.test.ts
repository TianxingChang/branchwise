import { afterEach, describe, expect, test } from "vitest";
import { highlightCodeTokens, resetHighlighter } from "@/lib/files/shiki";

afterEach(() => {
  resetHighlighter();
});

describe("highlightCodeTokens", () => {
  test("returns one token row per input line, text intact", async () => {
    const rows = await highlightCodeTokens(
      "const a = 1;\nlet b = 2;",
      "typescript"
    );

    expect(rows).toHaveLength(2);
    expect(rows?.[0].map((token) => token.text).join("")).toBe("const a = 1;");
    expect(rows?.[1].map((token) => token.text).join("")).toBe("let b = 2;");
    expect(rows?.[0].some((token) => token.color)).toBe(true);
  });

  test("returns null for plain text, which needs no markup", async () => {
    expect(await highlightCodeTokens("just words", "text")).toBeNull();
  });
});
