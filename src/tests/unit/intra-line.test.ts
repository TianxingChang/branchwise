import { describe, expect, test } from "vitest";
import { changedSegments, pairChangedLines } from "@/lib/git/intra-line";
import type { DiffLine } from "@/types/diff";

function line(kind: DiffLine["kind"], text: string): DiffLine {
  return {
    kind,
    newNo: kind === "del" ? null : 1,
    oldNo: kind === "add" ? null : 1,
    text,
  };
}

describe("changedSegments", () => {
  test("isolates the words that changed and keeps the rest", () => {
    const result = changedSegments("  return a + b;", "  const sum = a + b;");

    if (!result) {
      throw new Error("expected segments for a similar pair");
    }
    const oldJoined = result.old.map((segment) => segment.text).join("");
    const newJoined = result.new.map((segment) => segment.text).join("");
    expect(oldJoined).toBe("  return a + b;");
    expect(newJoined).toBe("  const sum = a + b;");

    const changedNew = result.new
      .filter((segment) => segment.changed)
      .map((segment) => segment.text)
      .join("");
    expect(changedNew).toContain("sum");
    expect(changedNew).not.toContain("a + b;");

    const keptNew = result.new.find((segment) =>
      segment.text.includes("a + b;")
    );
    expect(keptNew?.changed).toBe(false);
  });

  test("marks nothing when the lines are identical", () => {
    const result = changedSegments("same text", "same text");

    if (!result) {
      throw new Error("expected segments for identical lines");
    }
    expect(result.old.every((segment) => !segment.changed)).toBe(true);
    expect(result.new.every((segment) => !segment.changed)).toBe(true);
  });

  test("gives up on lines that share almost nothing", () => {
    expect(
      changedSegments('import { z } from "zod";', "const total = 41;")
    ).toBeNull();
  });
});

describe("pairChangedLines", () => {
  test("pairs a deletion run with the addition run that follows", () => {
    const lines = [
      line("context", "top"),
      line("del", "first old"),
      line("del", "second old"),
      line("add", "first new"),
      line("add", "second new"),
      line("context", "bottom"),
    ];

    expect(pairChangedLines(lines)).toEqual([
      [1, 3],
      [2, 4],
    ]);
  });

  test("leaves an unbalanced run partially paired", () => {
    const lines = [
      line("del", "one"),
      line("del", "two"),
      line("add", "merged"),
    ];

    expect(pairChangedLines(lines)).toEqual([[0, 2]]);
  });

  test("pairs nothing when a run has no counterpart", () => {
    expect(
      pairChangedLines([line("context", "a"), line("add", "new line")])
    ).toEqual([]);
  });
});
