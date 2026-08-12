export const LOCAL_STORAGE_KEYS = {
  LANGUAGE: "lang",
  THEME: "theme",
};

export const IPC_CHANNELS = {
  START_ORPC_SERVER: "start-orpc-server",
};

export const ENVIRONMENT_VARIABLES = {
  NODE_ENV: process.env.NODE_ENV,
};

/**
 * The window wears a browser-like frame: a translucent gutter on all four
 * sides with the tab strip floating in it, and the workspace in a rounded
 * card inset from the window edges.
 *
 * Both processes need these numbers. The renderer draws the strip; the main
 * process places the macOS traffic lights, which are native and know nothing
 * about the gutter — change the gutter here or they stop lining up.
 */
export const WINDOW_CHROME = {
  /** Inset of the frame from the window's left, right and bottom edges. */
  GUTTER: 6,
  /**
   * The whole header band, window top down to the workspace card. A browser's
   * proportions; taller starts reading as a title bar.
   *
   * The band gets no gutter above it. It used to, and the gutter pushed every
   * tab down without adding matching room underneath — 9px of air above a tab
   * and 3px below it, which reads as misaligned however well the tabs and the
   * traffic lights agree with each other. The strip spans the full band and
   * centres its contents, so the air above and below is equal by construction.
   */
  HEADER_HEIGHT: 40,
  /** macOS traffic lights are 12px circles, measured from their top-left. */
  TRAFFIC_LIGHT_DIAMETER: 12,
  /** Breathing room between the last button and the first tab. */
  TRAFFIC_LIGHT_GAP: 18,
  /** Span of the three buttons together: 12px each, 20px centre to centre. */
  TRAFFIC_LIGHT_GROUP_WIDTH: 52,
  /** Left inset of the traffic lights from the window edge. */
  TRAFFIC_LIGHT_X: 20,
} as const;

/** Vertical origin that centres the traffic lights in the header band. */
export const trafficLightY = (): number =>
  (WINDOW_CHROME.HEADER_HEIGHT - WINDOW_CHROME.TRAFFIC_LIGHT_DIAMETER) / 2;

/**
 * Where the first tab may start, measured from the strip's own left edge.
 * The traffic lights are placed in window coordinates and the strip sits a
 * gutter inside that horizontally, so the gutter comes back off the total.
 */
export const tabStripLeftInset = (): number =>
  WINDOW_CHROME.TRAFFIC_LIGHT_X +
  WINDOW_CHROME.TRAFFIC_LIGHT_GROUP_WIDTH +
  WINDOW_CHROME.TRAFFIC_LIGHT_GAP -
  WINDOW_CHROME.GUTTER;

export const inDevelopment = ENVIRONMENT_VARIABLES.NODE_ENV === "development";
