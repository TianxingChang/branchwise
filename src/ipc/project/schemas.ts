import { z } from "zod";
import { graphDocSchema } from "@/types/branch";

export const projectPathInputSchema = z.object({
  path: z.string().min(1),
});

export const saveGraphInputSchema = z.object({
  doc: graphDocSchema,
  path: z.string().min(1),
});
