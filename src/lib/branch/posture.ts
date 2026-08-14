import {
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  SIDEBAR_FLOOR,
} from "@/lib/branch/constants";
import { NODE_WIDTH } from "@/lib/branch/layout";
import type { BranchView, PanelPosture } from "@/types/branch";

/** Space the split posture must leave a graph: two nodes plus breathing room. */
const CANVAS_FLOOR = 2 * NODE_WIDTH + 32;

/** What the region left of the panel needs to stay worth looking at. */
function floorFor(view: BranchView): number {
  return view === "tree" ? SIDEBAR_FLOOR : CANVAS_FLOOR;
}

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
 * floor and the panel minimum, the panel minimum wins: a too-narrow panel is
 * unusable, a crowded branch list is merely cramped.
 *
 * The floor depends on what is being squeezed. A graph needs two nodes beside
 * each other to say anything; a list needs a readable branch name and no more,
 * which is what lets the panel widen until the tree is a sidebar.
 */
export function clampSplitWidth(
  windowWidth: number,
  width: number,
  view: BranchView = "canvas"
): number {
  const max = Math.min(MAX_PANEL_WIDTH, windowWidth - floorFor(view));
  return Math.max(MIN_PANEL_WIDTH, Math.min(max, Math.round(width)));
}
