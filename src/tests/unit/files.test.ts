import { describe, expect, test } from "vitest";
import {
  countLines,
  formatBytes,
  joinPath,
  matchesFilter,
  parentPath,
  sortEntries,
} from "@/lib/files/entries";
import {
  PathEscapeError,
  safeRelativePath,
  safeSegments,
} from "@/lib/files/path-safety";
import type { FileEntry } from "@/types/files";

function entry(name: string, kind: FileEntry["kind"]): FileEntry {
  return { isSymlink: false, kind, name, path: name, size: 0 };
}

describe("sortEntries", () => {
  test("puts directories before files", () => {
    const sorted = sortEntries([
      entry("readme.md", "file"),
      entry("src", "directory"),
    ]);

    expect(sorted.map((item) => item.name)).toEqual(["src", "readme.md"]);
  });

  test("sorts case-insensitively, the way a file browser reads", () => {
    const sorted = sortEntries([
      entry("biome.jsonc", "file"),
      entry("AGENTS.md", "file"),
      entry("CLAUDE.md", "file"),
      entry("bun.lock", "file"),
    ]);

    expect(sorted.map((item) => item.name)).toEqual([
      "AGENTS.md",
      "biome.jsonc",
      "bun.lock",
      "CLAUDE.md",
    ]);
  });

  test("orders numbered names the way people count", () => {
    const sorted = sortEntries([
      entry("file10.ts", "file"),
      entry("file2.ts", "file"),
    ]);

    expect(sorted.map((item) => item.name)).toEqual(["file2.ts", "file10.ts"]);
  });

  test("does not mutate its input", () => {
    const input = [entry("b", "file"), entry("a", "file")];
    sortEntries(input);

    expect(input.map((item) => item.name)).toEqual(["b", "a"]);
  });
});

describe("matchesFilter", () => {
  test("keeps everything for an empty filter", () => {
    expect(matchesFilter(entry("anything", "file"), "  ")).toBe(true);
  });

  test("matches anywhere in the name, ignoring case", () => {
    expect(matchesFilter(entry("BranchCanvas.tsx", "file"), "canvas")).toBe(
      true
    );
  });

  test("rejects a name that does not contain the needle", () => {
    expect(matchesFilter(entry("readme.md", "file"), "canvas")).toBe(false);
  });
});

describe("path helpers", () => {
  test("joins onto the root without a leading slash", () => {
    expect(joinPath("", "src")).toBe("src");
    expect(joinPath("src", "lib")).toBe("src/lib");
  });

  test("walks back up one level", () => {
    expect(parentPath("src/lib/git")).toBe("src/lib");
    expect(parentPath("src")).toBe("");
    expect(parentPath("")).toBe("");
  });

  test("formats sizes at a glance", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1_572_864)).toBe("1.5 MB");
  });
});

describe("safeSegments", () => {
  test("normalises a plain relative path", () => {
    expect(safeSegments("src/lib/git/parse.ts")).toEqual([
      "src",
      "lib",
      "git",
      "parse.ts",
    ]);
  });

  test("treats the root as no segments", () => {
    expect(safeSegments("")).toEqual([]);
    expect(safeSegments(".")).toEqual([]);
  });

  test("collapses redundant separators and dots", () => {
    expect(safeRelativePath("./src//lib/./git")).toBe("src/lib/git");
  });

  test("allows climbing back down to a path it already descended", () => {
    expect(safeRelativePath("src/lib/../git")).toBe("src/git");
  });

  test("refuses to climb above the root", () => {
    expect(() => safeSegments("../etc/passwd")).toThrow(PathEscapeError);
    expect(() => safeSegments("src/../../etc/passwd")).toThrow(PathEscapeError);
  });

  test("refuses an absolute path", () => {
    expect(() => safeSegments("/etc/passwd")).toThrow(PathEscapeError);
    expect(() => safeSegments("C:/Windows")).toThrow(PathEscapeError);
  });

  test("refuses a path that climbs using backslashes", () => {
    expect(() => safeSegments("..\\..\\secrets")).toThrow(PathEscapeError);
  });

  test("refuses an embedded NUL, which can truncate a path in C", () => {
    expect(() => safeSegments("safe\u0000/../../etc")).toThrow(PathEscapeError);
  });
});

describe("countLines", () => {
  test("counts an empty file as no lines", () => {
    expect(countLines("")).toBe(0);
  });

  test("does not count a trailing newline as another line", () => {
    expect(countLines("# demo\nsecond line\n")).toBe(2);
  });

  test("counts a last line with no trailing newline", () => {
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("only")).toBe(1);
  });

  test("counts blank lines in the middle", () => {
    expect(countLines("a\n\nb\n")).toBe(3);
  });
});
