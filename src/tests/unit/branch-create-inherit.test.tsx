import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import BranchCanvas from "@/components/canvas/branch-canvas";
import { useAgentStore } from "@/stores/agent-store";
import { useRepoStore } from "@/stores/repo-store";
import type { CanvasNode } from "@/types/branch";

// The draft's dirty-count probe hangs deliberately, same discipline as
// agent-tab.test.tsx's DiffStrip stub: no test here asserts on it, and it
// would otherwise race the seeded/asserted state with an unawaited fetch.
vi.mock("@/actions/repo", () => ({
  worktreeStatus: () => new Promise(() => undefined),
}));

/** @xyflow/react's ZoomPane observes its container unconditionally on mount;
 * jsdom has no ResizeObserver, so every test needs this stub. */
class StubResizeObserver {
  disconnect(): void {
    // no-op
  }
  observe(): void {
    // no-op
  }
  unobserve(): void {
    // no-op
  }
}

const BRANCH_FROM_MAIN = /branch from main/i;

const FOLDER = "/project";

const ROOT: CanvasNode = {
  branch: "main",
  detached: false,
  head: "abc1234",
  id: "/project",
  isRoot: true,
  locked: false,
  parentId: null,
  parentSource: "root",
  prunable: false,
};

function seedParentSession(hasConversation: boolean) {
  useAgentStore.setState({
    sessions: {
      [ROOT.id]: {
        attached: false,
        config: null,
        conversation: {
          activeTurnId: null,
          items: [],
          seq: 0,
          streamingText: "",
          streamingThinking: "",
        },
        hasConversation,
        inherited: null,
      },
    },
  });
}

function startDraft() {
  render(
    <BranchCanvas nodes={[ROOT]} projectFolder={FOLDER} selectedId={null} />
  );
  fireEvent.click(screen.getByRole("button", { name: BRANCH_FROM_MAIN }));
}

function nameAndCommit(name: string) {
  fireEvent.change(screen.getByPlaceholderText("branch name"), {
    target: { value: name },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create branch" }));
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useAgentStore.getState().reset();
});

describe("branch creation inheritance control", () => {
  test("does not render when the parent has no conversation", () => {
    seedParentSession(false);
    startDraft();

    expect(screen.queryByText("无")).not.toBeInTheDocument();
    expect(screen.queryByText("简报")).not.toBeInTheDocument();
    expect(screen.queryByText("完整历史")).not.toBeInTheDocument();
  });

  test("renders with 简报 selected by default, reaching createBranch's inherit argument", () => {
    seedParentSession(true);
    const createBranch = vi.fn(() => Promise.resolve({ ok: true as const }));
    useRepoStore.setState({ createBranch });
    startDraft();

    expect(screen.getByText("简报")).toHaveAttribute("aria-pressed", "true");

    nameAndCommit("feat-child");

    expect(createBranch).toHaveBeenCalledWith(FOLDER, "main", "feat-child", {
      mode: "brief",
      parentLabel: "main",
      parentWorktree: ROOT.id,
    });
  });

  test("choosing 完整历史 reaches createBranch's inherit argument", () => {
    seedParentSession(true);
    const createBranch = vi.fn(() => Promise.resolve({ ok: true as const }));
    useRepoStore.setState({ createBranch });
    startDraft();

    fireEvent.click(screen.getByText("完整历史"));
    nameAndCommit("feat-child");

    expect(createBranch).toHaveBeenCalledWith(FOLDER, "main", "feat-child", {
      mode: "full",
      parentLabel: "main",
      parentWorktree: ROOT.id,
    });
  });

  test("choosing 无 reaches createBranch with no inherit argument", () => {
    seedParentSession(true);
    const createBranch = vi.fn(() => Promise.resolve({ ok: true as const }));
    useRepoStore.setState({ createBranch });
    startDraft();

    fireEvent.click(screen.getByText("无"));
    nameAndCommit("feat-child");

    expect(createBranch).toHaveBeenCalledWith(
      FOLDER,
      "main",
      "feat-child",
      null
    );
  });
});
