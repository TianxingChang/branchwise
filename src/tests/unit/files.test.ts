import { describe, expect, test } from "vitest";
import { countLines, formatBytes } from "@/lib/files/entries";
import { isMarkdown, languageForFile, PLAIN_TEXT } from "@/lib/files/language";
import {
  PathEscapeError,
  safeRelativePath,
  safeSegments,
} from "@/lib/files/path-safety";
import {
  isDirectoryTreePath,
  shouldDescend,
  toRelativePath,
  toTreePath,
} from "@/lib/files/scan-policy";

describe("formatBytes", () => {
  test("formats sizes at a glance", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1_572_864)).toBe("1.5 MB");
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

describe("tree paths", () => {
  test("marks directories with a trailing slash", () => {
    // The marker is what keeps an empty directory visible: without it the
    // path-first tree has nothing to infer the folder from.
    expect(toTreePath("src", true)).toBe("src/");
    expect(toTreePath("src/index.ts", false)).toBe("src/index.ts");
  });

  test("recognises a directory path", () => {
    expect(isDirectoryTreePath("src/")).toBe(true);
    expect(isDirectoryTreePath("src/index.ts")).toBe(false);
  });

  test("strips the marker to get back a real path", () => {
    expect(toRelativePath("src/")).toBe("src");
    expect(toRelativePath("src/index.ts")).toBe("src/index.ts");
  });
});

describe("shouldDescend", () => {
  test("walks ordinary directories", () => {
    expect(shouldDescend("src")).toBe(true);
    expect(shouldDescend("docs")).toBe(true);
  });

  test("stops at directories nobody browses through", () => {
    expect(shouldDescend("node_modules")).toBe(false);
    expect(shouldDescend(".git")).toBe(false);
  });
});

describe("languageForFile", () => {
  test("maps common extensions to a grammar", () => {
    expect(languageForFile("src/index.ts")).toBe("typescript");
    expect(languageForFile("App.tsx")).toBe("tsx");
    expect(languageForFile("main.rs")).toBe("rust");
    expect(languageForFile("style.css")).toBe("css");
  });

  test("recognises dotfiles by name, which have no extension", () => {
    expect(languageForFile(".gitignore")).toBe("ini");
    expect(languageForFile("Dockerfile")).toBe("docker");
  });

  test("falls back to plain text rather than guessing", () => {
    expect(languageForFile("LICENSE")).toBe(PLAIN_TEXT);
    expect(languageForFile("data.weird")).toBe(PLAIN_TEXT);
  });

  test("identifies markdown, which renders through tiptap instead", () => {
    expect(isMarkdown("README.md")).toBe(true);
    expect(isMarkdown("notes.mdx")).toBe(true);
    expect(isMarkdown("index.ts")).toBe(false);
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
