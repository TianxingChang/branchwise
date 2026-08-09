import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { worktreeDiff } from "@/actions/repo";
import DiffTab from "@/components/panel/diff-tab";
import type { CanvasNode } from "@/types/branch";
import type { FileDiff, WorktreeDiff } from "@/types/diff";

const OLD_PATH = /src\/old\.ts/;
const UNTRACKED = /untracked/i;
const NO_CHANGES = /no changes against main/i;
const BAD_REVISION = /bad revision 'main'/;

vi.mock("@/actions/repo", () => ({
  worktreeDiff: vi.fn(),
}));

vi.mock("@/lib/files/shiki", () => ({
  highlightCodeLines: vi.fn(() => Promise.resolve(null)),
}));

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

function fileDiff(overrides: Partial<FileDiff>): FileDiff {
  return {
    additions: 1,
    binary: false,
    deletions: 0,
    dirty: false,
    hunks: [
      {
        header: "@@ -1 +1 @@",
        lines: [
          { kind: "del", newNo: null, oldNo: 1, text: "old" },
          { kind: "add", newNo: 1, oldNo: null, text: "new" },
        ],
        newLines: 1,
        newStart: 1,
        oldLines: 1,
        oldStart: 1,
      },
    ],
    kind: "modified",
    oldPath: null,
    path: "src/app.ts",
    ...overrides,
  };
}

function respond(diff: Partial<WorktreeDiff>) {
  vi.mocked(worktreeDiff).mockResolvedValue({
    baseRef: "abc",
    files: [],
    untracked: [],
    ...diff,
  });
}

function renderTab() {
  return render(
    <DiffTab node={node} parentBranch="main" projectFolder="/project" />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DiffTab", () => {
  test("renders each file with its counts and lines", async () => {
    respond({ files: [fileDiff({ additions: 1, deletions: 1 })] });
    renderTab();

    expect(await screen.findByText("src/app.ts")).toBeInTheDocument();
    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(screen.getByText("−1")).toBeInTheDocument();
    expect(screen.getByText("old")).toBeInTheDocument();
    expect(screen.getByText("new")).toBeInTheDocument();
  });

  test("badges a file that has uncommitted changes", async () => {
    respond({ files: [fileDiff({ dirty: true })] });
    renderTab();

    expect(await screen.findByText("uncommitted")).toBeInTheDocument();
  });

  test("shows a rename as old arrow new", async () => {
    respond({
      files: [fileDiff({ hunks: [], kind: "renamed", oldPath: "src/old.ts" })],
    });
    renderTab();

    expect(await screen.findByText(OLD_PATH)).toBeInTheDocument();
  });

  test("marks a binary file instead of rendering hunks", async () => {
    respond({
      files: [fileDiff({ binary: true, hunks: [], path: "logo.png" })],
    });
    renderTab();

    expect(await screen.findByText("binary file")).toBeInTheDocument();
  });

  test("lists untracked files by name", async () => {
    respond({ untracked: ["fresh.txt"] });
    renderTab();

    expect(await screen.findByText("fresh.txt")).toBeInTheDocument();
    expect(screen.getByText(UNTRACKED)).toBeInTheDocument();
  });

  test("says there is nothing to review when the diff is empty", async () => {
    respond({});
    renderTab();

    expect(await screen.findByText(NO_CHANGES)).toBeInTheDocument();
  });

  test("surfaces git's own words when the read fails", async () => {
    vi.mocked(worktreeDiff).mockRejectedValue(
      new Error("fatal: bad revision 'main'")
    );
    renderTab();

    expect(await screen.findByText(BAD_REVISION)).toBeInTheDocument();
  });
});
