import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { readTextFile } from "@/actions/files";
import { worktreeDiff } from "@/actions/repo";
import DiffTab from "@/components/panel/diff-tab";
import type { CanvasNode } from "@/types/branch";
import type { FileDiff, WorktreeDiff } from "@/types/diff";

const OLD_PATH = /src\/old\.ts/;
const UNTRACKED = /untracked/i;
const NO_CHANGES = /no changes against main/i;
const BAD_REVISION = /bad revision 'main'/;
const A_PLUS_B = /a \+ b;/;
const COLLAPSED_HINT = /files are collapsed for large diffs/i;
const NINE_UNMODIFIED = /9 unmodified lines/;
const FOUR_UNMODIFIED = /4 unmodified lines/;

vi.mock("@/actions/repo", () => ({
  worktreeDiff: vi.fn(),
}));

vi.mock("@/actions/files", () => ({
  readTextFile: vi.fn(),
}));

vi.mock("@/lib/files/shiki", () => ({
  highlightCodeTokens: vi.fn(() => Promise.resolve(null)),
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

  test("says what the diff is measured against", async () => {
    respond({ files: [fileDiff({})] });
    renderTab();

    expect(await screen.findByText("main → working tree")).toBeInTheDocument();
  });

  test("marks the words that changed inside a paired line", async () => {
    respond({
      files: [
        fileDiff({
          hunks: [
            {
              header: "@@ -1 +1 @@",
              lines: [
                {
                  kind: "del",
                  newNo: null,
                  oldNo: 1,
                  text: "  return a + b;",
                },
                {
                  kind: "add",
                  newNo: 1,
                  oldNo: null,
                  text: "  const sum = a + b;",
                },
              ],
              newLines: 1,
              newStart: 1,
              oldLines: 1,
              oldStart: 1,
            },
          ],
        }),
      ],
    });
    const { container } = renderTab();

    await screen.findAllByText(A_PLUS_B);
    const changed = [
      ...container.querySelectorAll('[data-changed="true"]'),
    ].map((span) => span.textContent);

    expect(changed.join(" ")).toContain("sum");
    expect(changed.join(" ")).not.toContain("b;");
  });

  test("collapses every file of a large diff behind a hint", async () => {
    respond({
      files: Array.from({ length: 16 }, (_, index) =>
        fileDiff({ path: `src/f${index}.ts` })
      ),
    });
    renderTab();

    expect(await screen.findByText(COLLAPSED_HINT)).toBeInTheDocument();
    expect(screen.queryByText("old")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("src/f0.ts"));
    expect(await screen.findByText("old")).toBeInTheDocument();
  });

  test("folds the unmodified stretch between hunks and expands it", async () => {
    vi.mocked(readTextFile).mockResolvedValue({
      kind: "text",
      lineCount: 20,
      size: 200,
      text: Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join("\n"),
    });
    respond({
      files: [
        fileDiff({
          hunks: [
            {
              header: "@@ -1,3 +1,3 @@",
              lines: [
                { kind: "context", newNo: 1, oldNo: 1, text: "L1" },
                { kind: "del", newNo: null, oldNo: 2, text: "old two" },
                { kind: "add", newNo: 2, oldNo: null, text: "new two" },
                { kind: "context", newNo: 3, oldNo: 3, text: "L3" },
              ],
              newLines: 3,
              newStart: 1,
              oldLines: 3,
              oldStart: 1,
            },
            {
              header: "@@ -13,3 +13,3 @@",
              lines: [
                { kind: "context", newNo: 13, oldNo: 13, text: "L13" },
                { kind: "del", newNo: null, oldNo: 14, text: "old x" },
                { kind: "add", newNo: 14, oldNo: null, text: "new x" },
                { kind: "context", newNo: 15, oldNo: 15, text: "L15" },
              ],
              newLines: 3,
              newStart: 13,
              oldLines: 3,
              oldStart: 13,
            },
          ],
        }),
      ],
    });
    renderTab();

    const fold = await screen.findByText(NINE_UNMODIFIED);
    fireEvent.click(fold);

    expect(await screen.findByText("L7")).toBeInTheDocument();
    expect(screen.queryByText(NINE_UNMODIFIED)).not.toBeInTheDocument();
  });

  test("folds the lines a hunk skips at the top of the file", async () => {
    vi.mocked(readTextFile).mockResolvedValue({
      kind: "text",
      lineCount: 10,
      size: 100,
      text: Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n"),
    });
    respond({
      files: [
        fileDiff({
          hunks: [
            {
              header: "@@ -5,2 +5,2 @@",
              lines: [
                { kind: "context", newNo: 5, oldNo: 5, text: "L5" },
                { kind: "add", newNo: 6, oldNo: null, text: "inserted" },
              ],
              newLines: 2,
              newStart: 5,
              oldLines: 1,
              oldStart: 5,
            },
          ],
        }),
      ],
    });
    renderTab();

    const fold = await screen.findByText(FOUR_UNMODIFIED);
    fireEvent.click(fold);

    expect(await screen.findByText("L2")).toBeInTheDocument();
  });
});
