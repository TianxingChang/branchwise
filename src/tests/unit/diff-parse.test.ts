import { describe, expect, test } from "vitest";
import { parseUnifiedDiff } from "@/lib/git/diff-parse";

const MODIFY = `diff --git a/src/util.ts b/src/util.ts
index 3b18e51..87a2c1d 100644
--- a/src/util.ts
+++ b/src/util.ts
@@ -1,5 +1,6 @@
 export function add(a: number, b: number) {
-  return a + b;
+  const sum = a + b;
+  return sum;
 }

 export const ZERO = 0;
`;

const ADD = `diff --git a/docs/note.md b/docs/note.md
new file mode 100644
index 0000000..d95f3ad
--- /dev/null
+++ b/docs/note.md
@@ -0,0 +1,2 @@
+# Note
+Hello.
`;

const DELETE = `diff --git a/old.txt b/old.txt
deleted file mode 100644
index 8baef1b..0000000
--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-abc
-def
`;

const RENAME_PURE = `diff --git a/src/a.ts b/src/b.ts
similarity index 100%
rename from src/a.ts
rename to src/b.ts
`;

const RENAME_EDIT = `diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 84%
rename from src/old-name.ts
rename to src/new-name.ts
index 3b18e51..87a2c1d 100644
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -3,3 +3,3 @@
 const keep = 1;
-const gone = 2;
+const here = 2;
 const tail = 3;
`;

const BINARY = `diff --git a/logo.png b/logo.png
index 5f2d1c3..9a41b77 100644
Binary files a/logo.png and b/logo.png differ
`;

const MULTI_HUNK = `diff --git a/src/two.ts b/src/two.ts
index 1111111..2222222 100644
--- a/src/two.ts
+++ b/src/two.ts
@@ -1,3 +1,3 @@
 top
-first old
+first new
 middle
@@ -10,3 +10,4 @@
 ten
 eleven
+eleven and a half
 twelve
`;

const NO_NEWLINE = `diff --git a/end.txt b/end.txt
index 0e290da..bb2ncmp 100644
--- a/end.txt
+++ b/end.txt
@@ -1 +1 @@
-old ending
\\ No newline at end of file
+new ending
\\ No newline at end of file
`;

const SPACE_PATH = `diff --git a/notes/my notes.md b/notes/my notes.md
index 3b18e51..87a2c1d 100644
--- a/notes/my notes.md
+++ b/notes/my notes.md
@@ -1 +1 @@
-a
+b
`;

describe("parseUnifiedDiff", () => {
  test("returns no files for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  test("reads one modified file with its counts", () => {
    const [file] = parseUnifiedDiff(MODIFY);

    expect(file.path).toBe("src/util.ts");
    expect(file.kind).toBe("modified");
    expect(file.oldPath).toBeNull();
    expect(file.binary).toBe(false);
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(1);
  });

  test("numbers context, deleted and added lines from the hunk header", () => {
    const [file] = parseUnifiedDiff(MODIFY);
    const [hunk] = file.hunks;

    expect(hunk.oldStart).toBe(1);
    expect(hunk.newStart).toBe(1);

    const first = hunk.lines[0];
    expect(first.kind).toBe("context");
    expect(first.oldNo).toBe(1);
    expect(first.newNo).toBe(1);

    const del = hunk.lines[1];
    expect(del.kind).toBe("del");
    expect(del.oldNo).toBe(2);
    expect(del.newNo).toBeNull();
    expect(del.text).toBe("  return a + b;");

    const added = hunk.lines[2];
    expect(added.kind).toBe("add");
    expect(added.oldNo).toBeNull();
    expect(added.newNo).toBe(2);

    const last = hunk.lines.at(-1);
    expect(last?.oldNo).toBe(5);
    expect(last?.newNo).toBe(6);
  });

  test("marks a new file as added", () => {
    const [file] = parseUnifiedDiff(ADD);

    expect(file.kind).toBe("added");
    expect(file.path).toBe("docs/note.md");
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(0);
  });

  test("marks a deleted file and keeps its old path", () => {
    const [file] = parseUnifiedDiff(DELETE);

    expect(file.kind).toBe("deleted");
    expect(file.path).toBe("old.txt");
    expect(file.deletions).toBe(2);
  });

  test("reads a pure rename with no hunks", () => {
    const [file] = parseUnifiedDiff(RENAME_PURE);

    expect(file.kind).toBe("renamed");
    expect(file.path).toBe("src/b.ts");
    expect(file.oldPath).toBe("src/a.ts");
    expect(file.hunks).toEqual([]);
  });

  test("reads a rename that also edits content", () => {
    const [file] = parseUnifiedDiff(RENAME_EDIT);

    expect(file.kind).toBe("renamed");
    expect(file.path).toBe("src/new-name.ts");
    expect(file.oldPath).toBe("src/old-name.ts");
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);
    expect(file.hunks).toHaveLength(1);
  });

  test("marks a binary file and gives it no hunks", () => {
    const [file] = parseUnifiedDiff(BINARY);

    expect(file.binary).toBe(true);
    expect(file.path).toBe("logo.png");
    expect(file.hunks).toEqual([]);
  });

  test("numbers a second hunk from its own header", () => {
    const [file] = parseUnifiedDiff(MULTI_HUNK);

    expect(file.hunks).toHaveLength(2);
    const second = file.hunks[1];
    expect(second.oldStart).toBe(10);
    expect(second.lines[2].kind).toBe("add");
    expect(second.lines[2].newNo).toBe(12);
    expect(second.lines[3].oldNo).toBe(12);
    expect(second.lines[3].newNo).toBe(13);
  });

  test("keeps no-newline markers out of the line list", () => {
    const [file] = parseUnifiedDiff(NO_NEWLINE);
    const texts = file.hunks[0].lines.map((line) => line.text);

    expect(texts).toEqual(["old ending", "new ending"]);
  });

  test("reads a path containing spaces from the file headers", () => {
    const [file] = parseUnifiedDiff(SPACE_PATH);

    expect(file.path).toBe("notes/my notes.md");
  });

  test("splits several files into separate entries", () => {
    const files = parseUnifiedDiff(MODIFY + ADD + BINARY);

    expect(files.map((file) => file.path)).toEqual([
      "src/util.ts",
      "docs/note.md",
      "logo.png",
    ]);
  });
});
