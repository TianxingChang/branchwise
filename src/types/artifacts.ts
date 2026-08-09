import { z } from "zod";

/**
 * The kinds of documents the artifact shelf can hold. A note is markdown, a
 * canvas is a tldraw snapshot — both stored as plain files so they survive
 * the app, diff cleanly, and can be opened by other tools.
 */
export const ARTIFACT_KINDS = ["note", "canvas"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const artifactMetaSchema = z.object({
  kind: z.enum(ARTIFACT_KINDS),
  /** The display name. Also the file name minus its extension. */
  name: z.string(),
  /** File mtime in milliseconds — the shelf has no index to keep one in. */
  updatedAt: z.number(),
});

export type ArtifactMeta = z.infer<typeof artifactMetaSchema>;
