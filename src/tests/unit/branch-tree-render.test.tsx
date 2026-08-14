import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import BranchTree from "@/components/canvas/branch-tree";
import { useAgentStore } from "@/stores/agent-store";
import type { CanvasNode } from "@/types/branch";

function node(id: string, parentId: string | null): CanvasNode {
  return {
    branch: id,
    detached: false,
    head: "abc1234",
    id,
    isRoot: parentId === null,
    locked: false,
    parentId,
    parentSource: parentId === null ? "root" : "created",
    prunable: false,
  };
}

afterEach(() => {
  cleanup();
  useAgentStore.getState().reset();
});

describe("BranchTree", () => {
  /**
   * A render test, because the failure this guards against is a crash rather
   * than a wrong pixel.
   *
   * Folding the agent activity *inside* the store selector returned a fresh
   * object on every call. The store hook is backed by useSyncExternalStore,
   * whose snapshot has to be stable, so a new object per render read as a new
   * value per render — "Maximum update depth exceeded" rather than a stale
   * badge. Nothing about the markup says so; only rendering it does.
   */
  test("renders the hierarchy without re-rendering itself to death", () => {
    render(
      <BranchTree
        nodes={[node("main", null), node("a", "main"), node("a1", "a")]}
        projectFolder="/repo"
        selectedId="a"
      />
    );

    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("a1")).toBeInTheDocument();
  });

  test("keeps rendering when a session lands in the agent store", () => {
    // The same selector runs again on every store change; a fresh object here
    // would loop on the update rather than on the first paint.
    render(
      <BranchTree
        nodes={[node("main", null)]}
        projectFolder="/repo"
        selectedId={null}
      />
    );

    useAgentStore.setState({ sessions: {} });

    expect(screen.getByText("main")).toBeInTheDocument();
  });

  test("offers branching from every row and deleting all but the root", () => {
    render(
      <BranchTree
        nodes={[node("main", null), node("a", "main")]}
        projectFolder="/repo"
        selectedId={null}
      />
    );

    expect(screen.getByLabelText("Branch from main")).toBeInTheDocument();
    expect(screen.getByLabelText("Delete a")).toBeInTheDocument();
    // The root worktree is git's own checkout; there is no removing it here.
    expect(screen.queryByLabelText("Delete main")).toBeNull();
  });
});
