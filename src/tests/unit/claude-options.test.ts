import { describe, expect, test } from "vitest";
import { buildClaudeOptions, sanitizedEnvironment } from "@/ipc/claude/options";

const BASE = {
  abortController: new AbortController(),
  canUseTool: () => Promise.resolve({ behavior: "allow" as const }),
  executable: "/Users/me/.local/bin/claude",
  resumeSessionId: null,
  tier: "accept-edits" as const,
  worktreePath: "/repo.worktrees/feat-a",
};

describe("sanitizedEnvironment", () => {
  test("strips git redirection variables that would retarget the agent", () => {
    const env = sanitizedEnvironment({
      GIT_DIR: "/somewhere/.git",
      GIT_INDEX_FILE: "/x",
      GIT_PREFIX: "sub/",
      GIT_WORK_TREE: "/somewhere",
      HOME: "/Users/me",
      PATH: "/usr/bin",
    });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.GIT_PREFIX).toBeUndefined();
    expect(env.HOME).toBe("/Users/me");
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("buildClaudeOptions", () => {
  test("cwd is the worktree, executable is the user's binary", () => {
    const options = buildClaudeOptions(BASE);
    expect(options.cwd).toBe("/repo.worktrees/feat-a");
    expect(options.pathToClaudeCodeExecutable).toBe(
      "/Users/me/.local/bin/claude"
    );
    expect(options.includePartialMessages).toBe(true);
    expect(options.resume).toBeUndefined();
  });

  test("tier maps to the documented permission modes", () => {
    expect(buildClaudeOptions({ ...BASE, tier: "plan" }).permissionMode).toBe(
      "plan"
    );
    expect(buildClaudeOptions({ ...BASE, tier: "ask" }).permissionMode).toBe(
      "default"
    );
    expect(buildClaudeOptions(BASE).permissionMode).toBe("acceptEdits");
    const yolo = buildClaudeOptions({ ...BASE, tier: "yolo" });
    expect(yolo.permissionMode).toBe("bypassPermissions");
    expect(yolo.allowDangerouslySkipPermissions).toBe(true);
  });

  test("non-yolo tiers never set the bypass escape hatch", () => {
    expect(
      buildClaudeOptions(BASE).allowDangerouslySkipPermissions
    ).toBeUndefined();
  });

  test("resume id is passed through when present", () => {
    expect(
      buildClaudeOptions({ ...BASE, resumeSessionId: "s-123" }).resume
    ).toBe("s-123");
  });
});
