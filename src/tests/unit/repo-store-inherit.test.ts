import { beforeEach, describe, expect, test, vi } from "vitest";
import { prepareAgentInheritance } from "@/actions/agent";
import { createWorktree } from "@/actions/repo";
import { createSeedDoc } from "@/lib/branch/doc";
import { useRepoStore } from "@/stores/repo-store";
import type { RepoInfo } from "@/types/branch";

vi.mock("@/actions/agent", () => ({
  prepareAgentInheritance: vi.fn(),
}));

vi.mock("@/actions/repo", () => ({
  createWorktree: vi.fn(),
}));

vi.mock("@/actions/project", () => ({
  loadGraph: vi.fn(() => Promise.resolve(null)),
  saveGraph: vi.fn(() => Promise.resolve()),
}));

const FOLDER = "/project";
const WORKTREE_PATH = "/project.worktrees/feat-child";

const repo: RepoInfo = {
  commonDir: "/project/.git",
  headBranch: "main",
  isEmpty: false,
  root: FOLDER,
  worktreeRoot: "/project.worktrees",
};

const INHERIT = {
  mode: "brief" as const,
  parentLabel: "main",
  parentWorktree: "/project",
};

function selectedWorktree(): string | null {
  return (
    useRepoStore.getState().projects[FOLDER]?.doc?.selectedWorktree ?? null
  );
}

beforeEach(() => {
  useRepoStore.setState({
    projects: {
      [FOLDER]: {
        doc: createSeedDoc(),
        error: null,
        nodes: [],
        repo,
        status: "ready",
        worktrees: [],
      },
    },
  });
  vi.mocked(createWorktree).mockResolvedValue({ worktreePath: WORKTREE_PATH });
  vi.mocked(prepareAgentInheritance).mockReset();
});

describe("createBranch never undoes the worktree it already created", () => {
  test("a thrown/rejected prepareAgentInheritance still selects the new worktree and reports the failure", async () => {
    vi.mocked(prepareAgentInheritance).mockRejectedValue(
      new Error("IPC transport dropped")
    );

    const result = await useRepoStore
      .getState()
      .createBranch(FOLDER, "main", "feat-child", INHERIT);

    expect(result).toEqual({ error: "IPC transport dropped", ok: false });
    expect(selectedWorktree()).toBe(WORKTREE_PATH);
  });

  test("a refused prepareAgentInheritance ({ok:false}) still selects the new worktree and reports the reason", async () => {
    vi.mocked(prepareAgentInheritance).mockResolvedValue({
      ok: false,
      reason: "The parent has no conversation to inherit.",
    });

    const result = await useRepoStore
      .getState()
      .createBranch(FOLDER, "main", "feat-child", INHERIT);

    expect(result).toEqual({
      error: "The parent has no conversation to inherit.",
      ok: false,
    });
    expect(selectedWorktree()).toBe(WORKTREE_PATH);
  });

  test("a successful inheritance selects the new worktree and reports ok:true", async () => {
    vi.mocked(prepareAgentInheritance).mockResolvedValue({ ok: true });

    const result = await useRepoStore
      .getState()
      .createBranch(FOLDER, "main", "feat-child", INHERIT);

    expect(result).toEqual({ ok: true });
    expect(selectedWorktree()).toBe(WORKTREE_PATH);
  });

  test("no inherit argument skips prepareAgentInheritance entirely but still selects", async () => {
    const result = await useRepoStore
      .getState()
      .createBranch(FOLDER, "main", "feat-child", null);

    expect(result).toEqual({ ok: true });
    expect(selectedWorktree()).toBe(WORKTREE_PATH);
    expect(prepareAgentInheritance).not.toHaveBeenCalled();
  });
});
