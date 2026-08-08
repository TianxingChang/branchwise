import { z } from "zod";

/** What the watcher reports so the tree can follow the disk. */
export const fileChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("changed"), path: z.string() }),
  z.object({ kind: z.literal("removed"), path: z.string() }),
]);

export const worktreeTreeSchema = z.object({
  /** Flat, slash-separated; directories carry a trailing slash. */
  paths: z.array(z.string()),
  /** True when the walk hit its limit and stopped early. */
  truncated: z.boolean(),
});

export const fileContentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    lineCount: z.number().int().min(0),
    size: z.number().int().min(0),
    text: z.string(),
  }),
  z.object({ kind: z.literal("binary"), size: z.number().int().min(0) }),
  z.object({ kind: z.literal("too-large"), size: z.number().int().min(0) }),
]);

export type FileContent = z.infer<typeof fileContentSchema>;
export type FileChange = z.infer<typeof fileChangeSchema>;
export type WorktreeTree = z.infer<typeof worktreeTreeSchema>;
