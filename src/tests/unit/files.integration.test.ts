import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { call } from "@orpc/server";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { list, read } from "@/ipc/files/handlers";

/**
 * Drives the real handlers against a real directory.
 *
 * The path guard is the reason this exists: the renderer supplies the relative
 * path, so "can it be talked into leaving the worktree" is a question only the
 * handler — with its own symlink resolution — can answer.
 */
let workspace: string;
let worktree: string;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "branchwise-files-unit-"));
  worktree = path.join(workspace, "tree");

  await mkdir(path.join(worktree, "src", "lib"), { recursive: true });
  await writeFile(path.join(worktree, "README.md"), "# demo\nsecond\n");
  await writeFile(path.join(worktree, "Alpha.txt"), "a\n");
  await writeFile(path.join(worktree, "beta.txt"), "b\n");
  await writeFile(path.join(worktree, "src", "index.ts"), "export {};\n");
  await writeFile(
    path.join(worktree, "logo.bin"),
    Buffer.from([0x89, 0x50, 0x00, 0x01])
  );
  await writeFile(path.join(workspace, "secret.txt"), "do not read me");
  await symlink(
    path.join(workspace, "secret.txt"),
    path.join(worktree, "escape-link")
  );
});

afterAll(async () => {
  if (workspace) {
    await rm(workspace, { force: true, recursive: true });
  }
});

describe("list", () => {
  test("returns the root with directories first", async () => {
    const listing = await call(list, { path: "", worktreePath: worktree });

    expect(listing.entries[0].name).toBe("src");
    expect(listing.entries.map((entry) => entry.name)).toContain("README.md");
  });

  test("sorts files case-insensitively", async () => {
    const listing = await call(list, { path: "", worktreePath: worktree });
    const files = listing.entries
      .filter((entry) => entry.kind === "file")
      .map((entry) => entry.name);

    expect(files.indexOf("Alpha.txt")).toBeLessThan(files.indexOf("beta.txt"));
  });

  test("returns paths relative to the worktree", async () => {
    const listing = await call(list, { path: "src", worktreePath: worktree });

    expect(listing.entries.map((entry) => entry.path)).toContain(
      "src/index.ts"
    );
  });

  test("marks a symlink as such", async () => {
    const listing = await call(list, { path: "", worktreePath: worktree });
    const link = listing.entries.find((entry) => entry.name === "escape-link");

    expect(link?.isSymlink).toBe(true);
  });
});

describe("read", () => {
  test("returns text with a line count", async () => {
    const content = await call(read, {
      path: "README.md",
      worktreePath: worktree,
    });

    expect(content.kind).toBe("text");
    if (content.kind === "text") {
      expect(content.text).toContain("second");
      expect(content.lineCount).toBe(2);
    }
  });

  test("recognises a binary file instead of rendering noise", async () => {
    const content = await call(read, {
      path: "logo.bin",
      worktreePath: worktree,
    });

    expect(content.kind).toBe("binary");
  });

  test("refuses a directory", async () => {
    await expect(
      call(read, { path: "src", worktreePath: worktree })
    ).rejects.toThrow();
  });
});

describe("the worktree boundary", () => {
  const escapes = [
    "../secret.txt",
    "src/../../secret.txt",
    "/etc/hosts",
    "..\\..\\secret.txt",
    "./../secret.txt",
  ];

  for (const attempt of escapes) {
    test(`refuses to read "${attempt}"`, async () => {
      await expect(
        call(read, { path: attempt, worktreePath: worktree })
      ).rejects.toThrow();
    });
  }

  test("refuses to list outside the worktree", async () => {
    await expect(
      call(list, { path: "../", worktreePath: worktree })
    ).rejects.toThrow();
  });

  test("does not follow a symlink that points outside", async () => {
    // The link sits inside the tree, so every textual check passes it — only
    // resolving the real path catches this one.
    await expect(
      call(read, { path: "escape-link", worktreePath: worktree })
    ).rejects.toThrow();
  });
});
