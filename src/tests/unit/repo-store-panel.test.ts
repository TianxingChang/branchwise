import { beforeEach, describe, expect, test, vi } from "vitest";
import { createSeedDoc } from "@/lib/branch/doc";
import { useRepoStore } from "@/stores/repo-store";
import type { PanelPosture, PanelTab, RepoInfo } from "@/types/branch";

vi.mock("@/actions/project", () => ({
  loadGraph: vi.fn(() => Promise.resolve(null)),
  saveGraph: vi.fn(() => Promise.resolve()),
}));

const FOLDER = "/project";

const repo: RepoInfo = {
  commonDir: "/project/.git",
  headBranch: "main",
  isEmpty: false,
  root: FOLDER,
  worktreeRoot: "/project.worktrees",
};

function seed(posture: PanelPosture, tab: PanelTab = "agent") {
  useRepoStore.setState({
    projects: {
      [FOLDER]: {
        doc: {
          ...createSeedDoc(),
          panel: { collapsed: false, posture, tab, width: 420 },
        },
        error: null,
        nodes: [],
        repo,
        status: "ready",
        worktrees: [],
      },
    },
  });
}

function panel() {
  const { doc } = useRepoStore.getState().projects[FOLDER];
  if (!doc) {
    throw new Error("doc missing");
  }
  return doc.panel;
}

describe("setPanelTab posture coupling", () => {
  beforeEach(() => {
    seed("peek");
  });

  test("opening the diff tab promotes the panel to full", () => {
    useRepoStore.getState().setPanelTab(FOLDER, "diff");

    expect(panel().tab).toBe("diff");
    expect(panel().posture).toBe("full");
  });

  test("leaving the diff tab restores the posture it interrupted", () => {
    useRepoStore.getState().setPanelTab(FOLDER, "diff");
    useRepoStore.getState().setPanelTab(FOLDER, "agent");

    expect(panel().tab).toBe("agent");
    expect(panel().posture).toBe("peek");
  });

  test("a persisted full posture falls back to split when leaving diff", () => {
    seed("full", "diff");

    useRepoStore.getState().setPanelTab(FOLDER, "terminal");

    expect(panel().posture).toBe("split");
  });

  test("leaving diff keeps a posture the user changed while reviewing", () => {
    useRepoStore.getState().setPanelTab(FOLDER, "diff");
    useRepoStore.getState().setPanelPosture(FOLDER, "split");
    useRepoStore.getState().setPanelTab(FOLDER, "agent");

    expect(panel().posture).toBe("split");
  });
});

describe("setPanelPosture", () => {
  beforeEach(() => {
    seed("peek");
  });

  test("stores the posture it is given", () => {
    useRepoStore.getState().setPanelPosture(FOLDER, "full");

    expect(panel().posture).toBe("full");
  });
});
