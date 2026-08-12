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

describe("setPanelTab leaves posture alone", () => {
  beforeEach(() => {
    seed("peek");
  });

  test("opening the diff tab keeps the posture it was opened from", () => {
    useRepoStore.getState().setPanelTab(FOLDER, "diff");

    expect(panel().tab).toBe("diff");
    expect(panel().posture).toBe("peek");
  });

  test("opening the diff tab from split stays split", () => {
    seed("split");

    useRepoStore.getState().setPanelTab(FOLDER, "diff");

    expect(panel().posture).toBe("split");
  });

  test("leaving the diff tab keeps the posture too", () => {
    seed("split", "diff");

    useRepoStore.getState().setPanelTab(FOLDER, "agent");

    expect(panel().tab).toBe("agent");
    expect(panel().posture).toBe("split");
  });

  test("a full posture survives leaving the diff tab", () => {
    seed("full", "diff");

    useRepoStore.getState().setPanelTab(FOLDER, "terminal");

    expect(panel().posture).toBe("full");
  });

  test("the panel width is untouched by tab changes", () => {
    const before = panel().width;

    useRepoStore.getState().setPanelTab(FOLDER, "diff");

    expect(panel().width).toBe(before);
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
