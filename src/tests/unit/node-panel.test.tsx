import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import NodePanel from "@/components/panel/node-panel";
import { createSeedDoc } from "@/lib/branch/doc";
import { useRepoStore } from "@/stores/repo-store";
import type {
  CanvasNode,
  PanelPosture,
  PanelState,
  RepoInfo,
} from "@/types/branch";

vi.mock("@/actions/project", () => ({
  loadGraph: vi.fn(() => Promise.resolve(null)),
  saveGraph: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/actions/repo", () => ({
  worktreeDiff: vi.fn(() => new Promise(() => undefined)),
  worktreeDiffSummary: vi.fn(() => new Promise(() => undefined)),
  worktreeStatus: vi.fn(() => new Promise(() => undefined)),
}));

vi.mock("@/components/panel/agent-tab", () => ({
  default: () => null,
}));
vi.mock("@/components/panel/artifact-tab", () => ({
  default: () => null,
}));
vi.mock("@/components/panel/view-tab", () => ({
  default: () => null,
}));
vi.mock("@/components/panel/file-tab", () => ({
  default: () => null,
}));
vi.mock("@/components/panel/terminal-tab", () => ({
  default: () => null,
}));
vi.mock("@/components/panel/diff-tab", () => ({
  default: () => null,
}));

const FOLDER = "/project";

const repo: RepoInfo = {
  commonDir: "/project/.git",
  headBranch: "main",
  isEmpty: false,
  root: FOLDER,
  worktreeRoot: "/project.worktrees",
};

const node: CanvasNode = {
  branch: "feat/x",
  detached: false,
  head: "abc123",
  id: "/project.worktrees/feat-x",
  isRoot: false,
  locked: false,
  parentId: "/project",
  parentSource: "created",
  prunable: false,
};

function seedAndRender(posture: PanelPosture) {
  const panel: PanelState = {
    collapsed: false,
    posture,
    tab: "agent",
    width: 420,
  };
  useRepoStore.setState({
    projects: {
      [FOLDER]: {
        doc: {
          ...createSeedDoc(),
          panel,
          selectedWorktree: node.id,
        },
        error: null,
        nodes: [node],
        repo,
        status: "ready",
        worktrees: [],
      },
    },
  });

  return render(
    <NodePanel
      node={node}
      nodes={[node]}
      panel={panel}
      parentBranch="main"
      projectFolder={FOLDER}
      view="canvas"
    />
  );
}

function storedPanel() {
  const { doc } = useRepoStore.getState().projects[FOLDER];
  if (!doc) {
    throw new Error("doc missing");
  }
  return doc.panel;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("tab order", () => {
  test("runs Agent, Diff, Terminal, File, View, Artifact", () => {
    seedAndRender("split");
    const known = ["Agent", "Diff", "Terminal", "File", "View", "Artifact"];
    const tabs = screen
      .getAllByRole("button")
      .map((button) => button.textContent)
      .filter((label) => known.includes(label ?? ""));

    expect(tabs).toEqual(known);
  });
});

describe("posture chrome", () => {
  test("carries its posture on the container", () => {
    seedAndRender("peek");

    expect(screen.getByRole("complementary")).toHaveAttribute(
      "data-posture",
      "peek"
    );
  });

  test("Escape dismisses a peek overlay", () => {
    seedAndRender("peek");

    fireEvent.keyDown(screen.getByRole("complementary"), { key: "Escape" });

    expect(storedPanel().collapsed).toBe(true);
  });

  test("Escape leaves a docked split panel alone", () => {
    seedAndRender("split");

    fireEvent.keyDown(screen.getByRole("complementary"), { key: "Escape" });

    expect(storedPanel().collapsed).toBe(false);
  });
});

describe("resize handle", () => {
  test("is a keyboard-adjustable separator", () => {
    const { rerender } = seedAndRender("split");
    const handle = screen.getByRole("separator");

    expect(handle).toHaveAttribute("aria-valuenow", "420");

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(storedPanel().width).toBe(436);

    // The workspace re-renders the panel from the store on every change;
    // mirror that so the second keypress starts from the committed width.
    rerender(
      <NodePanel
        node={node}
        nodes={[node]}
        panel={storedPanel()}
        parentBranch="main"
        projectFolder={FOLDER}
        view="canvas"
      />
    );

    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });
    expect(storedPanel().width).toBe(420);
  });
});
