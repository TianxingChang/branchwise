import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { call } from "@orpc/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import {
  create,
  list,
  read,
  remove,
  renameArtifact,
  write,
} from "@/ipc/artifacts/handlers";

/**
 * Drives the real handlers against a real directory. The shelf has no index
 * file, so "does a listing agree with the disk" and "does create refuse to
 * clobber" are questions only the filesystem can answer.
 */
let workspace: string;
let project: string;

const shelfDir = () => path.join(project, ".branchwise", "artifacts");

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "branchwise-artifacts-"));
});

beforeEach(async () => {
  project = path.join(
    workspace,
    `project-${Math.random().toString(36).slice(2, 8)}`
  );
  await mkdir(project, { recursive: true });
});

afterAll(async () => {
  await rm(workspace, { force: true, recursive: true });
});

describe("list", () => {
  test("an absent shelf lists as empty", async () => {
    await expect(call(list, { path: project })).resolves.toEqual([]);
  });

  test("lists only files the shelf owns, sorted by name", async () => {
    await mkdir(shelfDir(), { recursive: true });
    await writeFile(path.join(shelfDir(), "beta.md"), "b");
    await writeFile(path.join(shelfDir(), "Alpha.tldr"), "");
    await writeFile(path.join(shelfDir(), ".DS_Store"), "");
    await writeFile(path.join(shelfDir(), "stray.txt"), "not ours");
    await mkdir(path.join(shelfDir(), "subdir.md"), { recursive: true });

    const metas = await call(list, { path: project });
    expect(metas.map((meta) => ({ kind: meta.kind, name: meta.name }))).toEqual(
      [
        { kind: "canvas", name: "Alpha" },
        { kind: "note", name: "beta" },
      ]
    );
    for (const meta of metas) {
      expect(meta.updatedAt).toBeGreaterThan(0);
    }
  });
});

describe("create", () => {
  test("creates Finder-style numbered names per kind", async () => {
    const first = await call(create, { kind: "note", path: project });
    const second = await call(create, { kind: "note", path: project });
    const canvas = await call(create, { kind: "canvas", path: project });

    expect(first?.name).toBe("Note");
    expect(second?.name).toBe("Note 2");
    expect(canvas?.name).toBe("Canvas");

    const files = await readdir(shelfDir());
    expect(files.sort()).toEqual(["Canvas.tldr", "Note 2.md", "Note.md"]);
  });

  test("steps past a collision the scan cannot see", async () => {
    // A directory named like a note: the listing skips it (not a file), but
    // writeFile("wx") still collides — exactly the race the retry loop is for.
    await mkdir(path.join(shelfDir(), "Note.md"), { recursive: true });

    const created = await call(create, { kind: "note", path: project });
    expect(created?.name).toBe("Note 2");
  });
});

describe("read and write", () => {
  test("round-trips content", async () => {
    await call(write, {
      content: "# hello\n",
      kind: "note",
      name: "Plan",
      path: project,
    });
    await expect(
      call(read, { kind: "note", name: "Plan", path: project })
    ).resolves.toEqual({ content: "# hello\n" });
  });

  test("read of a missing artifact is null", async () => {
    await expect(
      call(read, { kind: "note", name: "Nowhere", path: project })
    ).resolves.toBeNull();
  });

  test("rejects names that could leave the shelf", async () => {
    await expect(
      call(read, { kind: "note", name: "../graph", path: project })
    ).rejects.toThrow();
    await expect(
      call(write, {
        content: "x",
        kind: "note",
        name: ".hidden",
        path: project,
      })
    ).rejects.toThrow();
  });
});

describe("rename", () => {
  test("renames and reports the new identity", async () => {
    await call(create, { kind: "note", path: project });
    const renamed = await call(renameArtifact, {
      kind: "note",
      name: "Note",
      path: project,
      to: "Meeting minutes",
    });

    expect(renamed?.name).toBe("Meeting minutes");
    await expect(readdir(shelfDir())).resolves.toEqual(["Meeting minutes.md"]);
  });

  test("suffixes instead of clobbering a taken name", async () => {
    await call(write, { content: "a", kind: "note", name: "A", path: project });
    await call(write, { content: "b", kind: "note", name: "B", path: project });

    const renamed = await call(renameArtifact, {
      kind: "note",
      name: "A",
      path: project,
      to: "B",
    });

    expect(renamed?.name).toBe("B 2");
    await expect(
      call(read, { kind: "note", name: "B", path: project })
    ).resolves.toEqual({ content: "b" });
  });

  test("a case-only rename stays on the same file", async () => {
    await call(write, {
      content: "x",
      kind: "note",
      name: "draft",
      path: project,
    });

    const renamed = await call(renameArtifact, {
      kind: "note",
      name: "draft",
      path: project,
      to: "Draft",
    });

    expect(renamed?.name).toBe("Draft");
    await expect(
      call(read, { kind: "note", name: "Draft", path: project })
    ).resolves.toEqual({ content: "x" });
  });

  test("renaming a missing artifact is null", async () => {
    await expect(
      call(renameArtifact, {
        kind: "note",
        name: "Ghost",
        path: project,
        to: "Anything",
      })
    ).resolves.toBeNull();
  });
});

describe("remove", () => {
  test("deletes the file and only that file", async () => {
    await call(create, { kind: "note", path: project });
    await call(create, { kind: "canvas", path: project });

    await expect(
      call(remove, { kind: "note", name: "Note", path: project })
    ).resolves.toBe(true);
    await expect(readdir(shelfDir())).resolves.toEqual(["Canvas.tldr"]);
  });

  test("removing what is already gone reports true", async () => {
    await expect(
      call(remove, { kind: "note", name: "Ghost", path: project })
    ).resolves.toBe(true);
  });
});
