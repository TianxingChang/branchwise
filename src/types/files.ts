import { z } from "zod";

export const fileEntrySchema = z.object({
  /** True for a symlink, whatever it points at. */
  isSymlink: z.boolean(),
  kind: z.enum(["directory", "file"]),
  name: z.string(),
  /** Slash-separated, relative to the worktree root. */
  path: z.string(),
  /** Bytes; zero for directories. */
  size: z.number().int().min(0),
});

export const directoryListingSchema = z.object({
  entries: z.array(fileEntrySchema),
  path: z.string(),
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

export type FileEntry = z.infer<typeof fileEntrySchema>;
export type DirectoryListing = z.infer<typeof directoryListingSchema>;
export type FileContent = z.infer<typeof fileContentSchema>;
