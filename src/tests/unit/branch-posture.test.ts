import { describe, expect, test } from "vitest";
import {
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  SIDEBAR_FLOOR,
} from "@/lib/branch/constants";
import { clampSplitWidth, cyclePosture } from "@/lib/branch/posture";

describe("cyclePosture", () => {
  test("cycles peek to split to full and around", () => {
    expect(cyclePosture("peek")).toBe("split");
    expect(cyclePosture("split")).toBe("full");
    expect(cyclePosture("full")).toBe("peek");
  });
});

describe("clampSplitWidth", () => {
  test("keeps the absolute maximum on a wide window", () => {
    // Wide enough that the window is not the binding limit — the point is the
    // absolute ceiling, so the window has to clear it by the canvas floor.
    expect(clampSplitWidth(3200, 5000)).toBe(MAX_PANEL_WIDTH);
  });

  test("a tree yields more room to the panel than a graph does", () => {
    // The panel widening into a sidebar arrangement is the whole reason the
    // floor depends on the view; holding a list to the graph's floor is what
    // stopped it.
    const asGraph = clampSplitWidth(1400, 5000, "canvas");
    const asTree = clampSplitWidth(1400, 5000, "tree");

    expect(asTree).toBeGreaterThan(asGraph);
    expect(1400 - asTree).toBe(SIDEBAR_FLOOR);
  });

  test("leaves two node widths of canvas on a narrow window", () => {
    // 900 − reserved canvas must still hold two 184px nodes plus gutters.
    const clamped = clampSplitWidth(900, 700);

    expect(clamped).toBeLessThan(700);
    expect(900 - clamped).toBeGreaterThanOrEqual(2 * 184);
  });

  test("never collapses the panel below its own minimum", () => {
    expect(clampSplitWidth(500, 400)).toBe(MIN_PANEL_WIDTH);
  });
});
