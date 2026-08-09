import { describe, expect, test } from "vitest";
import { MAX_PANEL_WIDTH, MIN_PANEL_WIDTH } from "@/lib/branch/constants";
import {
  clampSplitWidth,
  cyclePosture,
  postureOnOpenTab,
} from "@/lib/branch/posture";

describe("cyclePosture", () => {
  test("cycles peek to split to full and around", () => {
    expect(cyclePosture("peek")).toBe("split");
    expect(cyclePosture("split")).toBe("full");
    expect(cyclePosture("full")).toBe("peek");
  });
});

describe("clampSplitWidth", () => {
  test("keeps the absolute maximum on a wide window", () => {
    expect(clampSplitWidth(2000, 5000)).toBe(MAX_PANEL_WIDTH);
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

describe("postureOnOpenTab", () => {
  test("opening the diff tab promotes the panel to full", () => {
    expect(postureOnOpenTab("diff", "peek")).toBe("full");
    expect(postureOnOpenTab("diff", "split")).toBe("full");
  });

  test("other tabs keep the current posture", () => {
    expect(postureOnOpenTab("agent", "peek")).toBe("peek");
    expect(postureOnOpenTab("terminal", "split")).toBe("split");
  });
});
