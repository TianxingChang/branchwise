import { describe, expect, test } from "vitest";
import {
  addChild,
  BranchTreeError,
  childrenOf,
  createSeedDoc,
  descendantIds,
  normalizeBranchName,
  ROOT_BRANCH_ID,
  removeSubtree,
  renameNode,
  suggestBranchName,
} from "@/lib/branch/tree";
import type { BranchNode } from "@/types/branch";

const EMPTY_NAME = /cannot be empty/;
const NO_BRANCH = /No branch/;
const ROOT_PROTECTED = /root branch cannot be deleted/;
const NAME_TAKEN = /already exists/;

const byName = (left: string, right: string) => left.localeCompare(right);

function tree(): BranchNode[] {
  const seed = createSeedDoc(0).nodes;
  const a = addChild(seed, ROOT_BRANCH_ID, "feature-a", { id: "a", now: 1 });
  const b = addChild(a.nodes, ROOT_BRANCH_ID, "feature-b", { id: "b", now: 2 });
  const c = addChild(b.nodes, "a", "feature-a-1", { id: "c", now: 3 });
  const d = addChild(c.nodes, "c", "feature-a-1-1", { id: "d", now: 4 });
  return d.nodes;
}

describe("normalizeBranchName", () => {
  test("folds whitespace into dashes", () => {
    expect(normalizeBranchName("  add   login flow ")).toBe("add-login-flow");
  });

  test("strips characters git rejects in a ref", () => {
    expect(normalizeBranchName("fix~the^thing:now?")).toBe("fix-the-thing-now");
  });

  test("trims separators off the edges", () => {
    expect(normalizeBranchName("/-feature/x-.")).toBe("feature/x");
  });

  test("keeps slashes, which git allows", () => {
    expect(normalizeBranchName("feat/agent-panel")).toBe("feat/agent-panel");
  });

  test("returns empty when nothing usable survives", () => {
    expect(normalizeBranchName("  ~^: ")).toBe("");
  });
});

describe("createSeedDoc", () => {
  test("starts with a single selected root named main", () => {
    const doc = createSeedDoc(0);

    expect(doc.nodes).toHaveLength(1);
    expect(doc.nodes[0].parentId).toBeNull();
    expect(doc.nodes[0].name).toBe("main");
    expect(doc.selectedNodeId).toBe(doc.nodes[0].id);
  });
});

describe("addChild", () => {
  test("attaches the new branch to its parent", () => {
    const seed = createSeedDoc(0).nodes;
    const { node, nodes } = addChild(seed, ROOT_BRANCH_ID, "feature-a");

    expect(nodes).toHaveLength(2);
    expect(node.parentId).toBe(ROOT_BRANCH_ID);
    expect(childrenOf(nodes, ROOT_BRANCH_ID)).toHaveLength(1);
  });

  test("normalizes the name before storing it", () => {
    const seed = createSeedDoc(0).nodes;
    const { node } = addChild(seed, ROOT_BRANCH_ID, "  Add  Login ");

    expect(node.name).toBe("Add-Login");
  });

  test("does not mutate the input array", () => {
    const seed = createSeedDoc(0).nodes;
    addChild(seed, ROOT_BRANCH_ID, "feature-a");

    expect(seed).toHaveLength(1);
  });

  test("rejects a duplicate name", () => {
    const nodes = tree();

    expect(() => addChild(nodes, ROOT_BRANCH_ID, "feature-a")).toThrow(
      BranchTreeError
    );
  });

  test("rejects an empty name", () => {
    const seed = createSeedDoc(0).nodes;

    expect(() => addChild(seed, ROOT_BRANCH_ID, "   ")).toThrow(EMPTY_NAME);
  });

  test("rejects an unknown parent", () => {
    const seed = createSeedDoc(0).nodes;

    expect(() => addChild(seed, "nope", "feature-a")).toThrow(NO_BRANCH);
  });
});

describe("descendantIds", () => {
  test("collects the whole subtree, excluding the node itself", () => {
    expect(descendantIds(tree(), "a").sort(byName)).toEqual(["c", "d"]);
  });

  test("returns nothing for a leaf", () => {
    expect(descendantIds(tree(), "d")).toEqual([]);
  });
});

describe("removeSubtree", () => {
  test("removes the node and everything under it", () => {
    const { nodes, removedIds } = removeSubtree(tree(), "a");

    expect(removedIds.sort(byName)).toEqual(["a", "c", "d"]);
    expect(nodes.map((node) => node.id).sort(byName)).toEqual([
      "b",
      ROOT_BRANCH_ID,
    ]);
  });

  test("leaves sibling subtrees alone", () => {
    const { nodes } = removeSubtree(tree(), "b");

    expect(nodes.map((node) => node.id).sort(byName)).toEqual([
      "a",
      "c",
      "d",
      ROOT_BRANCH_ID,
    ]);
  });

  test("refuses to remove the root", () => {
    expect(() => removeSubtree(tree(), ROOT_BRANCH_ID)).toThrow(ROOT_PROTECTED);
  });

  test("rejects an unknown id", () => {
    expect(() => removeSubtree(tree(), "nope")).toThrow(NO_BRANCH);
  });
});

describe("renameNode", () => {
  test("renames in place", () => {
    const nodes = renameNode(tree(), "a", "feature-renamed");

    expect(nodes.find((node) => node.id === "a")?.name).toBe("feature-renamed");
  });

  test("allows renaming a node to its own name", () => {
    expect(() => renameNode(tree(), "a", "feature-a")).not.toThrow();
  });

  test("rejects colliding with another branch", () => {
    expect(() => renameNode(tree(), "a", "feature-b")).toThrow(NAME_TAKEN);
  });
});

describe("suggestBranchName", () => {
  test("skips names already in use", () => {
    const { nodes: seed } = createSeedDoc(0);
    const { nodes } = addChild(seed, ROOT_BRANCH_ID, "branch-1", { id: "x" });

    expect(suggestBranchName(nodes)).toBe("branch-2");
  });
});
