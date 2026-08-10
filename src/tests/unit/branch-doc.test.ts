import { describe, expect, test } from "vitest";
import { MAX_PANEL_WIDTH, MIN_PANEL_WIDTH } from "@/lib/branch/constants";
import {
  createSeedDoc,
  parseGraphDoc,
  serializeGraphDoc,
} from "@/lib/branch/doc";
import type { GraphDoc } from "@/types/branch";

function populated(): GraphDoc {
  return {
    ...createSeedDoc(),
    branches: {
      "feat/a": { parent: "main", parentSource: "reflog" },
      "feat/b": { parent: "feat/a", parentSource: "user" },
    },
    selectedWorktree: "/repo.worktrees/feat-a",
  };
}

describe("graph doc round-trip", () => {
  test("survives serialize then parse unchanged", () => {
    const doc = populated();

    expect(parseGraphDoc(JSON.parse(serializeGraphDoc(doc)))).toEqual(doc);
  });

  test("serializes to newline-terminated json", () => {
    expect(serializeGraphDoc(createSeedDoc()).endsWith("}\n")).toBe(true);
  });
});

describe("createSeedDoc", () => {
  test("starts with no annotations and nothing selected", () => {
    const doc = createSeedDoc();

    expect(doc.branches).toEqual({});
    expect(doc.selectedWorktree).toBeNull();
  });
});

describe("parseGraphDoc", () => {
  test("rejects a payload that is not a doc", () => {
    expect(parseGraphDoc(null)).toBeNull();
    expect(parseGraphDoc({})).toBeNull();
  });

  test("rejects a v1 document, whose node list git never knew about", () => {
    const v1 = {
      nodes: [
        {
          createdAt: 0,
          id: "main",
          name: "main",
          parentId: null,
          stats: { done: 0, pending: 0, running: 0 },
          status: "idle",
        },
      ],
      panel: { collapsed: false, tab: "agent", width: 420 },
      selectedNodeId: "main",
      version: 1,
    };

    expect(parseGraphDoc(v1)).toBeNull();
  });

  test("rejects an unknown parentSource", () => {
    const doc = {
      ...createSeedDoc(),
      branches: { "feat/a": { parent: "main", parentSource: "guessed" } },
    };

    expect(parseGraphDoc(doc)).toBeNull();
  });

  test("accepts a null parent, which means it hangs off the root", () => {
    const doc = {
      ...createSeedDoc(),
      branches: { "feat/a": { parent: null, parentSource: "root" } },
    };

    expect(parseGraphDoc(doc)?.branches["feat/a"].parent).toBeNull();
  });

  test("clamps a panel width written outside the allowed range", () => {
    const narrow = parseGraphDoc({
      ...createSeedDoc(),
      panel: { collapsed: false, tab: "agent", width: 10 },
    });
    const wide = parseGraphDoc({
      ...createSeedDoc(),
      panel: { collapsed: false, tab: "agent", width: 5000 },
    });

    expect(narrow?.panel.width).toBe(MIN_PANEL_WIDTH);
    expect(wide?.panel.width).toBe(MAX_PANEL_WIDTH);
  });

  test("rejects an unknown panel tab", () => {
    expect(
      parseGraphDoc({
        ...createSeedDoc(),
        panel: { collapsed: false, tab: "settings", width: 420 },
      })
    ).toBeNull();
  });

  test("fills in split for a doc written before postures existed", () => {
    const doc = parseGraphDoc({
      ...createSeedDoc(),
      panel: { collapsed: false, tab: "agent", width: 420 },
    });

    expect(doc?.panel.posture).toBe("split");
  });

  test("rejects an unknown posture", () => {
    expect(
      parseGraphDoc({
        ...createSeedDoc(),
        panel: {
          collapsed: false,
          posture: "floating",
          tab: "agent",
          width: 420,
        },
      })
    ).toBeNull();
  });
});

describe("panel posture", () => {
  test("a fresh project opens its panel as a peek overlay", () => {
    expect(createSeedDoc().panel.posture).toBe("peek");
  });
});
