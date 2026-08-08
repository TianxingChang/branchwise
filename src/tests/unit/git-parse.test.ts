import { describe, expect, test } from "vitest";
import {
  detachedLabel,
  normalizeBranchName,
  slugForBranch,
} from "@/lib/git/naming";
import { parseBranchOrigin, parseWorktreeList } from "@/lib/git/parse";

const PORCELAIN = `worktree /repo
HEAD a2ac37fc31a69484cb83d3203981ffc657bcbab5
branch refs/heads/main

worktree /repo.worktrees/feat-a
HEAD 1e43047164da74eeee938bd65541cf77f71b16b5
branch refs/heads/feat/a

worktree /repo.worktrees/loose
HEAD 9999999999999999999999999999999999999999
detached

worktree /repo.worktrees/gone
HEAD 8888888888888888888888888888888888888888
branch refs/heads/gone
prunable gitdir file points to non-existent location
`;

describe("parseWorktreeList", () => {
  test("reads every record", () => {
    expect(parseWorktreeList(PORCELAIN)).toHaveLength(4);
  });

  test("strips the refs/heads prefix from branches", () => {
    const [main, feature] = parseWorktreeList(PORCELAIN);

    expect(main.branch).toBe("main");
    expect(feature.branch).toBe("feat/a");
  });

  test("marks a detached worktree and leaves its branch null", () => {
    const [, , detached] = parseWorktreeList(PORCELAIN);

    expect(detached.detached).toBe(true);
    expect(detached.branch).toBeNull();
  });

  test("reads prunable even when it carries a reason", () => {
    expect(parseWorktreeList(PORCELAIN)[3].prunable).toBe(true);
  });

  test("handles a bare repository record", () => {
    const entries = parseWorktreeList("worktree /repo.git\nbare\n");

    expect(entries).toHaveLength(1);
    expect(entries[0].bare).toBe(true);
    expect(entries[0].head).toBe("");
  });

  test("ignores keys a newer git might add", () => {
    const entries = parseWorktreeList(
      "worktree /repo\nHEAD abc\nbranch refs/heads/main\nsomething-new value\n"
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].branch).toBe("main");
  });

  test("returns nothing for empty output", () => {
    expect(parseWorktreeList("")).toEqual([]);
    expect(parseWorktreeList("\n\n")).toEqual([]);
  });
});

describe("parseBranchOrigin", () => {
  test("reads a named start point", () => {
    expect(parseBranchOrigin("branch: Created from feat/a")).toEqual({
      kind: "ref",
      ref: "feat/a",
    });
  });

  test("strips a fully qualified start point", () => {
    expect(parseBranchOrigin("branch: Created from refs/heads/feat/a")).toEqual(
      {
        kind: "ref",
        ref: "feat/a",
      }
    );
  });

  test("recognises the implicit HEAD form", () => {
    expect(parseBranchOrigin("branch: Created from HEAD")).toEqual({
      kind: "head",
    });
  });

  test("returns null for any other reflog subject", () => {
    expect(parseBranchOrigin("commit: initial")).toBeNull();
    expect(parseBranchOrigin("")).toBeNull();
  });
});

describe("slugForBranch", () => {
  test("flattens slashes instead of nesting directories", () => {
    expect(slugForBranch("feat/agent-panel")).toBe("feat-agent-panel");
  });

  test("removes characters that are awkward in a path", () => {
    expect(slugForBranch("fix/ünicode & spaces")).toBe("fix-nicode-spaces");
  });

  test("never returns an empty directory name", () => {
    expect(slugForBranch("///")).toBe("branch");
  });
});

describe("normalizeBranchName", () => {
  test("folds whitespace and rejects ref-invalid characters", () => {
    expect(normalizeBranchName("  add   login flow ")).toBe("add-login-flow");
    expect(normalizeBranchName("fix~the^thing:now?")).toBe("fix-the-thing-now");
  });

  test("keeps slashes, which git allows", () => {
    expect(normalizeBranchName("feat/agent-panel")).toBe("feat/agent-panel");
  });

  test("returns empty when nothing usable survives", () => {
    expect(normalizeBranchName("  ~^: ")).toBe("");
  });
});

describe("detachedLabel", () => {
  test("shows an abbreviated sha", () => {
    expect(detachedLabel("1e43047164da74eeee938bd65541cf77f71b16b5")).toBe(
      "detached @ 1e43047"
    );
  });
});
