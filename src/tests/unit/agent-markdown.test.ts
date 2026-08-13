import { describe, expect, test } from "vitest";
import { splitFences } from "@/lib/agent/markdown";

describe("splitFences", () => {
  test("plain prose is one segment", () => {
    expect(splitFences("just words")).toEqual([
      { kind: "prose", text: "just words" },
    ]);
  });

  test("pulls a fenced block out of the prose around it", () => {
    expect(splitFences("before\n```ts\nconst a = 1;\n```\nafter")).toEqual([
      { kind: "prose", text: "before" },
      { kind: "code", language: "ts", open: false, text: "const a = 1;" },
      { kind: "prose", text: "after" },
    ]);
  });

  test("a fence with no language is still code", () => {
    expect(splitFences("```\nraw\n```")).toEqual([
      { kind: "code", language: null, open: false, text: "raw" },
    ]);
  });

  test("an unterminated fence is code that is still arriving", () => {
    // Mid-stream the closing fence has not been written yet. Treating the
    // rest as prose would render a half-finished block as running text and
    // then reflow it into a code block a token later.
    expect(splitFences("here:\n```py\nprint(1)")).toEqual([
      { kind: "prose", text: "here:" },
      { kind: "code", language: "py", open: true, text: "print(1)" },
    ]);
  });

  test("keeps several blocks apart", () => {
    const parts = splitFences("a\n```js\n1\n```\nb\n```sh\nls\n```");

    expect(parts.map((part) => part.kind)).toEqual([
      "prose",
      "code",
      "prose",
      "code",
    ]);
  });

  test("drops the empty prose between adjacent fences", () => {
    const parts = splitFences("```js\n1\n```\n```sh\nls\n```");

    expect(parts.map((part) => part.kind)).toEqual(["code", "code"]);
  });

  test("a tilde fence counts too", () => {
    expect(splitFences("~~~ts\nx\n~~~")).toEqual([
      { kind: "code", language: "ts", open: false, text: "x" },
    ]);
  });

  test("an indented fence closes only on its own marker", () => {
    // A ``` inside a block quote or list keeps its indent; the closer has to
    // be recognised or the block runs to the end of the message.
    expect(splitFences("```md\n# not a fence\n```")).toEqual([
      { kind: "code", language: "md", open: false, text: "# not a fence" },
    ]);
  });

  test("empty text produces nothing to render", () => {
    expect(splitFences("")).toEqual([]);
  });
});
