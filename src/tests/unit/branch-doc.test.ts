import { describe, expect, test } from "vitest";
import { parseGraphDoc, serializeGraphDoc } from "@/lib/branch/doc";
import {
  addChild,
  createSeedDoc,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  ROOT_BRANCH_ID,
} from "@/lib/branch/tree";
import type { GraphDoc } from "@/types/branch";

function docWithChildren(): GraphDoc {
  const seed = createSeedDoc(0);
  const a = addChild(seed.nodes, ROOT_BRANCH_ID, "feature-a", { id: "a" });
  const b = addChild(a.nodes, "a", "feature-a-1", { id: "b" });
  return { ...seed, nodes: b.nodes };
}

describe("graph doc round-trip", () => {
  test("survives serialize then parse unchanged", () => {
    const doc = docWithChildren();
    const parsed = parseGraphDoc(JSON.parse(serializeGraphDoc(doc)));

    expect(parsed).toEqual(doc);
  });

  test("serializes to newline-terminated json", () => {
    expect(serializeGraphDoc(createSeedDoc(0)).endsWith("}\n")).toBe(true);
  });
});

describe("parseGraphDoc", () => {
  test("rejects a payload that is not a doc", () => {
    expect(parseGraphDoc(null)).toBeNull();
    expect(parseGraphDoc({})).toBeNull();
    expect(parseGraphDoc({ nodes: [] })).toBeNull();
  });

  test("rejects a future schema version", () => {
    const doc = { ...createSeedDoc(0), version: 2 };

    expect(parseGraphDoc(doc)).toBeNull();
  });

  test("rejects a doc with no root", () => {
    const doc = createSeedDoc(0);
    const orphaned = {
      ...doc,
      nodes: [{ ...doc.nodes[0], parentId: "ghost" }],
    };

    expect(parseGraphDoc(orphaned)).toBeNull();
  });

  test("drops nodes that no longer reach the root", () => {
    const doc = docWithChildren();
    const withOrphan: GraphDoc = {
      ...doc,
      nodes: [
        ...doc.nodes,
        {
          createdAt: 0,
          id: "ghost",
          name: "ghost",
          parentId: "deleted",
          stats: { done: 0, pending: 0, running: 0 },
          status: "idle",
        },
      ],
    };

    const parsed = parseGraphDoc(withOrphan);

    expect(parsed?.nodes.map((node) => node.id).sort()).toEqual([
      "a",
      "b",
      ROOT_BRANCH_ID,
    ]);
  });

  test("falls back to the first node when the selection is gone", () => {
    const doc = { ...docWithChildren(), selectedNodeId: "vanished" };

    expect(parseGraphDoc(doc)?.selectedNodeId).toBe(ROOT_BRANCH_ID);
  });

  test("clamps a panel width written outside the allowed range", () => {
    const narrow = parseGraphDoc({
      ...createSeedDoc(0),
      panel: { collapsed: false, tab: "agent", width: 10 },
    });
    const wide = parseGraphDoc({
      ...createSeedDoc(0),
      panel: { collapsed: false, tab: "agent", width: 5000 },
    });

    expect(narrow?.panel.width).toBe(MIN_PANEL_WIDTH);
    expect(wide?.panel.width).toBe(MAX_PANEL_WIDTH);
  });

  test("drops a viewport left over from an older file", () => {
    const doc = {
      ...createSeedDoc(0),
      viewport: { x: -120, y: 40, zoom: 0.75 },
    };

    const parsed = parseGraphDoc(doc);

    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("viewport");
  });

  test("rejects an unknown panel tab", () => {
    const doc = {
      ...createSeedDoc(0),
      panel: { collapsed: false, tab: "settings", width: 420 },
    };

    expect(parseGraphDoc(doc)).toBeNull();
  });
});
