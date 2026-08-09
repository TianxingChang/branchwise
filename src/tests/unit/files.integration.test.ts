import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { call } from "@orpc/server";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { read, tree } from "@/ipc/files/handlers";
import { scanWorktree } from "@/ipc/files/scan";
import {
  stopAllWatching,
  subscribeToChanges,
  unsubscribeFromChanges,
} from "@/ipc/files/watcher";
import type { FileChange } from "@/types/files";

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
  await mkdir(path.join(worktree, "empty-dir"), { recursive: true });
  await mkdir(path.join(worktree, "node_modules", "left-pad"), {
    recursive: true,
  });
  await writeFile(path.join(worktree, "README.md"), "# demo\nsecond\n");
  await writeFile(path.join(worktree, "src", "index.ts"), "export {};\n");
  await writeFile(path.join(worktree, "src", "lib", "deep.ts"), "export {};\n");
  await writeFile(
    path.join(worktree, "node_modules", "left-pad", "index.js"),
    "module.exports = 1;\n"
  );
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
  stopAllWatching();
  if (workspace) {
    await rm(workspace, { force: true, recursive: true });
  }
});

describe("scanWorktree", () => {
  test("returns every path as one flat list", async () => {
    const { paths } = await scanWorktree(worktree);

    expect(paths).toContain("README.md");
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("src/lib/deep.ts");
  });

  test("marks directories so an empty one still appears", async () => {
    const { paths } = await scanWorktree(worktree);

    expect(paths).toContain("empty-dir/");
    expect(paths).toContain("src/");
  });

  test("lists a heavy directory without walking into it", async () => {
    const { paths } = await scanWorktree(worktree);

    // The folder is real and should be visible; its contents are not worth
    // shipping to a path-first tree.
    expect(paths).toContain("node_modules/");
    expect(
      paths.some((entry) => entry.startsWith("node_modules/left-pad"))
    ).toBe(false);
  });

  test("stops at the limit and says so", async () => {
    const result = await scanWorktree(worktree, { limit: 3 });

    expect(result.paths).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  test("reports a complete walk as not truncated", async () => {
    expect((await scanWorktree(worktree)).truncated).toBe(false);
  });

  test("keeps shallow paths when it has to stop early", async () => {
    // Breadth-first: whatever survives is what someone would navigate to.
    const { paths } = await scanWorktree(worktree, { limit: 4 });

    expect(paths.every((entry) => !entry.includes("/lib/"))).toBe(true);
  });
});

describe("tree", () => {
  test("is reachable through the router surface", async () => {
    const result = await call(tree, { worktreePath: worktree });

    expect(result.paths).toContain("src/index.ts");
    expect(result.truncated).toBe(false);
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

  test("does not follow a symlink that points outside", async () => {
    // The link sits inside the tree, so every textual check passes it — only
    // resolving the real path catches this one.
    await expect(
      call(read, { path: "escape-link", worktreePath: worktree })
    ).rejects.toThrow();
  });
});

describe("the file watcher", () => {
  const openQueues: (() => void)[] = [];

  afterEach(() => {
    for (const close of openQueues.splice(0)) {
      close();
    }
  });

  async function collect(root: string) {
    const seen: FileChange[] = [];
    const queue = subscribeToChanges(root);
    const controller = new AbortController();

    const pump = (async () => {
      for await (const change of queue.iterate(controller.signal)) {
        seen.push(change);
      }
    })();

    openQueues.push(() => {
      controller.abort();
      unsubscribeFromChanges(root, queue);
    });

    // A watcher that has just started cannot report what happened before it
    // was listening; give the first one in a run time to come up.
    await new Promise((resolve) => setTimeout(resolve, 250));

    return { pump, seen };
  }

  async function eventually(predicate: () => boolean, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) {
        return;
      }
      // Polling loop: each wait must finish before the next check.
      // biome-ignore lint/performance/noAwaitInLoops: see above
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("the watcher never reported the change");
  }

  test("reports a file created outside the app", async () => {
    const { seen } = await collect(worktree);
    const created = path.join(worktree, "src", "created.ts");

    await writeFile(created, "export const created = true;\n");

    await eventually(() =>
      seen.some(
        (change) =>
          change.kind === "changed" && change.path === "src/created.ts"
      )
    );

    await unlink(created);
  }, 30_000);

  test("reports a file deleted outside the app", async () => {
    const doomed = path.join(worktree, "src", "doomed.ts");
    await writeFile(doomed, "export {};\n");

    const { seen } = await collect(worktree);
    await unlink(doomed);

    await eventually(() =>
      seen.some(
        (change) => change.kind === "removed" && change.path === "src/doomed.ts"
      )
    );
  }, 30_000);

  test("reports an edit to an existing file", async () => {
    const { seen } = await collect(worktree);

    await writeFile(path.join(worktree, "README.md"), "# demo\nedited\n");

    await eventually(() =>
      seen.some(
        (change) => change.kind === "changed" && change.path === "README.md"
      )
    );
  }, 30_000);

  test("stays quiet about directories it never walked", async () => {
    const { seen } = await collect(worktree);

    await writeFile(
      path.join(worktree, "node_modules", "left-pad", "extra.js"),
      "module.exports = 2;\n"
    );
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(
      seen.some((change) => change.path.startsWith("node_modules/left-pad"))
    ).toBe(false);
  }, 30_000);
});
