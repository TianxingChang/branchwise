import { z } from "zod";

/**
 * What one changed file looks like after parsing `git diff` output. This is
 * the model the renderer receives — patch text never crosses the IPC boundary.
 */
export const DIFF_LINE_KINDS = ["context", "add", "del"] as const;
export type DiffLineKind = (typeof DIFF_LINE_KINDS)[number];

export const diffLineSchema = z.object({
  kind: z.enum(DIFF_LINE_KINDS),
  /** Line number in the new file, null for deleted lines. */
  newNo: z.number().int().min(1).nullable(),
  /** Line number in the old file, null for added lines. */
  oldNo: z.number().int().min(1).nullable(),
  /** Line content without the leading marker character. */
  text: z.string(),
});

export const diffHunkSchema = z.object({
  /** The raw `@@ … @@` line, kept for the hunk header row. */
  header: z.string(),
  lines: z.array(diffLineSchema),
  newLines: z.number().int().min(0),
  newStart: z.number().int().min(0),
  oldLines: z.number().int().min(0),
  oldStart: z.number().int().min(0),
});

export const FILE_DIFF_KINDS = [
  "modified",
  "added",
  "deleted",
  "renamed",
] as const;
export type FileDiffKind = (typeof FILE_DIFF_KINDS)[number];

export const fileDiffSchema = z.object({
  additions: z.number().int().min(0),
  /** Binary files have no hunks and no line counts. */
  binary: z.boolean(),
  deletions: z.number().int().min(0),
  /** True when the worktree has uncommitted changes touching this path. */
  dirty: z.boolean(),
  hunks: z.array(diffHunkSchema),
  kind: z.enum(FILE_DIFF_KINDS),
  /** Previous path when the file was renamed, otherwise null. */
  oldPath: z.string().nullable(),
  /** New path — or the old path for a deleted file. */
  path: z.string(),
});

export const worktreeDiffSchema = z.object({
  /** The merge-base the diff was taken against, or "HEAD" for the root node. */
  baseRef: z.string(),
  files: z.array(fileDiffSchema),
  /**
   * Paths git does not track yet — a freshly created file never shows up in
   * `git diff`, so the view lists these by name instead of dropping them.
   */
  untracked: z.array(z.string()),
});

export const diffSummarySchema = z.object({
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  files: z.number().int().min(0),
});

export type DiffLine = z.infer<typeof diffLineSchema>;
export type DiffHunk = z.infer<typeof diffHunkSchema>;
export type FileDiff = z.infer<typeof fileDiffSchema>;
export type WorktreeDiff = z.infer<typeof worktreeDiffSchema>;
export type DiffSummary = z.infer<typeof diffSummarySchema>;
