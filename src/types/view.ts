import { z } from "zod";

/**
 * What the embedded page's webContents currently reports. Streamed to the
 * renderer whenever any of it changes; the latest state always wins.
 */
export const viewStateSchema = z.object({
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  /** Chromium's failure name ("ERR_CONNECTION_REFUSED"), null when fine. */
  failure: z.string().nullable(),
  loading: z.boolean(),
  title: z.string(),
  url: z.string(),
});

export type ViewState = z.infer<typeof viewStateSchema>;

/** Window-relative CSS pixels, as measured by getBoundingClientRect. */
export const viewBoundsSchema = z.object({
  height: z.number().int().min(0).max(32_768),
  width: z.number().int().min(0).max(32_768),
  x: z.number().int().min(0).max(32_768),
  y: z.number().int().min(0).max(32_768),
});

export type ViewBounds = z.infer<typeof viewBoundsSchema>;
