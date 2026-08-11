import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getAgentConfig } from "@/actions/agent";
import BranchCanvas from "@/components/canvas/branch-canvas";
import { useRepoStore } from "@/stores/repo-store";
import type { CanvasNode } from "@/types/branch";

// The draft's dirty-count probe hangs deliberately, same discipline as
// agent-tab.test.tsx's DiffStrip stub: no test here asserts on it, and it
// would otherwise race the seeded/asserted state with an unawaited fetch.
vi.mock("@/actions/repo", () => ({
  worktreeStatus: () => new Promise(() => undefined),
}));

// Final-review A4: the inherit control now reads whether the parent has a
// conversation from the actions layer (branch-canvas's per-draft effect),
// not the agent store — the store only populates a worktree's session once
// AgentTab has mounted for it this run, which made the control disappear
// after a relaunch. Every test below leaves the agent store untouched
// (empty) and drives visibility purely through this mock instead.
//
// branch-node.tsx still pulls useAgentStore/selectSession/agentActivity for
// the (unrelated) running/needs-approval badge, and that store's module
// eagerly binds every actions/agent export at import time — so every export
// needs a stub here, not just getAgentConfig, or the import itself throws.
// None of the others are ever exercised in this file: nothing here mounts
// AgentTab or calls the store's open(), so they hang deliberately (same
// discipline as agent-tab.test.tsx's stubActions()).
vi.mock("@/actions/agent", () => ({
  agentHistory: vi.fn(() => new Promise(() => undefined)),
  attachAgent: vi.fn(() => new Promise(() => undefined)),
  getAgentConfig: vi.fn(),
  interruptAgent: vi.fn(() => Promise.resolve({ ok: true as const })),
  prepareAgentInheritance: vi.fn(),
  respondAgentPermission: vi.fn(() => Promise.resolve({ ok: true })),
  sendAgentMessage: vi.fn(() => Promise.resolve({ accepted: true })),
  setAgentConfig: vi.fn(() => Promise.resolve({ ok: true as const })),
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

function seedParentConversation(hasConversation: boolean) {
  vi.mocked(getAgentConfig).mockResolvedValue({
    config: { driverId: "claude-code", tier: "accept-edits" },
    hasConversation,
    inherited: null,
    turnActive: false,
  });
}

async function startDraft() {
  render(
    <BranchCanvas nodes={[ROOT]} projectFolder={FOLDER} selectedId={null} />
  );
  fireEvent.click(screen.getByRole("button", { name: BRANCH_FROM_MAIN }));
  // Let branch-canvas's per-draft effect resolve the mocked getAgentConfig
  // call (already scheduled by the click above) before the test asserts on
  // what it rendered. A macrotask tick drains every pending microtask ahead
  // of it, so this holds regardless of how many hops the effect's own
  // then/catch chain takes.
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

function nameAndCommit(name: string) {
  fireEvent.change(screen.getByPlaceholderText("branch name"), {
    target: { value: name },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create branch" }));
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  vi.mocked(getAgentConfig).mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("branch creation inheritance control", () => {
  // Final-review A4's own acceptance test: the agent store is never touched
  // anywhere in this file (no useAgentStore import, no setState) — every
  // "renders" case below is already "store empty, parent has a conversation
  // on disk (mocked)".
  test("does not render when the parent has no conversation", async () => {
    seedParentConversation(false);
    await startDraft();

    expect(screen.queryByText("无")).not.toBeInTheDocument();
    expect(screen.queryByText("简报")).not.toBeInTheDocument();
    expect(screen.queryByText("完整历史")).not.toBeInTheDocument();
  });

  test("renders with 简报 selected by default, reaching createBranch's inherit argument", async () => {
    seedParentConversation(true);
    const createBranch = vi.fn(() => Promise.resolve({ ok: true as const }));
    useRepoStore.setState({ createBranch });
    await startDraft();

    expect(screen.getByText("简报")).toHaveAttribute("aria-pressed", "true");

    nameAndCommit("feat-child");

    expect(createBranch).toHaveBeenCalledWith(FOLDER, "main", "feat-child", {
      mode: "brief",
      parentLabel: "main",
      parentWorktree: ROOT.id,
    });
  });

  test("choosing 完整历史 reaches createBranch's inherit argument", async () => {
    seedParentConversation(true);
    const createBranch = vi.fn(() => Promise.resolve({ ok: true as const }));
    useRepoStore.setState({ createBranch });
    await startDraft();

    fireEvent.click(screen.getByText("完整历史"));
    nameAndCommit("feat-child");

    expect(createBranch).toHaveBeenCalledWith(FOLDER, "main", "feat-child", {
      mode: "full",
      parentLabel: "main",
      parentWorktree: ROOT.id,
    });
  });

  test("choosing 无 reaches createBranch with no inherit argument", async () => {
    seedParentConversation(true);
    const createBranch = vi.fn(() => Promise.resolve({ ok: true as const }));
    useRepoStore.setState({ createBranch });
    await startDraft();

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
