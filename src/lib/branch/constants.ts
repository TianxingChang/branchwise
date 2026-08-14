export const DEFAULT_PANEL_WIDTH = 420;
export const MIN_PANEL_WIDTH = 340;
/**
 * Absolute ceiling on the panel, above whatever the window allows.
 *
 * Generous rather than tidy: on a wide display the intended arrangement is a
 * narrow list on the left and the work on the right, and a 1200px cap made
 * that impossible to reach however wide the window was.
 */
export const MAX_PANEL_WIDTH = 2400;
/** The strip of live canvas the panel leaves visible while full. */
export const RAIL_WIDTH = 208;

/**
 * The least the branch list may be squeezed to while the panel is docked.
 *
 * A graph needs two nodes side by side to be worth looking at; a list needs
 * enough room to read a branch name. Holding the list to the graph's floor is
 * what stopped the panel widening into the sidebar arrangement it is for.
 */
export const SIDEBAR_FLOOR = 220;
/**
 * The floating panel's inset from the workspace card's edges (tailwind
 * top-1.5/right-1.5/bottom-1.5). Deliberately equal to WINDOW_CHROME.GUTTER —
 * change one and the two nested frames stop matching.
 */
export const PANEL_GUTTER = 6;
