import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import AgentTab from "@/components/panel/agent-tab";
import { createSeedDoc } from "@/lib/branch/doc";
import { useRepoStore } from "@/stores/repo-store";
import type { RepoInfo } from "@/types/branch";

vi.mock("@/actions/project", () => ({
  loadGraph: vi.fn(() => Promise.resolve(null)),
  saveGraph: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/actions/repo", () => ({
  worktreeDiffSummary: vi.fn(() =>
    Promise.resolve({ additions: 3, deletions: 1, files: 2 })
  ),
}));

const FOLDER = "/project";
const WORKTREE = "/project.worktrees/feat-x";

const repo: RepoInfo = {
  commonDir: "/project/.git",
  headBranch: "main",
  isEmpty: false,
  root: FOLDER,
  worktreeRoot: "/project.worktrees",
};

beforeEach(() => {
  vi.clearAllMocks();
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
});

function renderTab() {
  return render(
    <AgentTab
      branchLabel="feat/x"
      head="abc123"
      nodeId={WORKTREE}
      parentBranch="main"
      projectFolder={FOLDER}
    />
  );
}

const TWO_FILES = /2 files/;
const PLUS_THREE = /\+3/;
const MINUS_ONE = /−1/;

describe("the agent tab's diff strip", () => {
  test("answers 'is this going somewhere sane' in one line", async () => {
    renderTab();

    expect(await screen.findByText(TWO_FILES)).toBeInTheDocument();
    expect(screen.getByText(PLUS_THREE)).toBeInTheDocument();
    expect(screen.getByText(MINUS_ONE)).toBeInTheDocument();
  });

  test("clicking the strip opens the diff tab full", async () => {
    renderTab();

    fireEvent.click(await screen.findByText(TWO_FILES));

    const { doc } = useRepoStore.getState().projects[FOLDER];
    expect(doc?.panel.tab).toBe("diff");
    expect(doc?.panel.posture).toBe("full");
  });
});
