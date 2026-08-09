import { MAX_PANEL_WIDTH, MIN_PANEL_WIDTH } from "@/lib/branch/constants";
import { NODE_WIDTH } from "@/lib/branch/layout";
import type { PanelPosture, PanelTab } from "@/types/branch";

/** Space the split posture must leave the canvas: two nodes plus breathing room. */
const CANVAS_FLOOR = 2 * NODE_WIDTH + 32;

const CYCLE: Record<PanelPosture, PanelPosture> = {
  full: "peek",
  peek: "split",
  split: "full",
};

/** The single-shortcut rotation: peek → split → full → peek. */
export function cyclePosture(current: PanelPosture): PanelPosture {
  return CYCLE[current];
}

/**
 * The split posture's width limit, relative to the window rather than a
 * constant — the old absolute clamp allowed 168px of canvas at minimum window
 * width, narrower than a single node. When the window cannot honour both the
 * canvas floor and the panel minimum, the panel minimum wins: a too-narrow
 * panel is unusable, a crowded canvas is merely cramped.
 */
export function clampSplitWidth(windowWidth: number, width: number): number {
  const max = Math.min(MAX_PANEL_WIDTH, windowWidth - CANVAS_FLOOR);
  return Math.max(MIN_PANEL_WIDTH, Math.min(max, Math.round(width)));
}

/** Opening the Diff tab is the review gesture — it takes the window. */
export function postureOnOpenTab(
  tab: PanelTab,
  current: PanelPosture
): PanelPosture {
  return tab === "diff" ? "full" : current;
}
