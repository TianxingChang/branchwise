import { z } from "zod";
import { sanitizeArtifactName } from "@/lib/artifacts/naming";
import { ARTIFACT_KINDS } from "@/types/artifacts";

/**
 * A name must arrive already valid — the handler never rewrites what the
 * renderer asked for, because the file it creates has to be the file the
 * renderer believes exists.
 */
const artifactNameSchema = z
  .string()
  .refine((value) => sanitizeArtifactName(value) === value, {
    message: "Not a usable artifact name.",
  });

export const listArtifactsInputSchema = z.object({
  path: z.string(),
});

export const createArtifactInputSchema = z.object({
  kind: z.enum(ARTIFACT_KINDS),
  path: z.string(),
});

export const artifactRefInputSchema = z.object({
  kind: z.enum(ARTIFACT_KINDS),
  name: artifactNameSchema,
  path: z.string(),
});

export const writeArtifactInputSchema = artifactRefInputSchema.extend({
  content: z.string(),
});

export const renameArtifactInputSchema = artifactRefInputSchema.extend({
  to: artifactNameSchema,
});
