import { z } from "zod";

/**
 * What the main process sends a terminal view. `data` carries raw bytes for
 * xterm, including escape sequences; `exit` arrives once and is terminal.
 */
export const terminalEventSchema = z.discriminatedUnion("kind", [
  z.object({
    data: z.string(),
    kind: z.literal("data"),
  }),
  z.object({
    exitCode: z.number().int(),
    kind: z.literal("exit"),
    signal: z.number().int().nullable(),
  }),
]);

export type TerminalEvent = z.infer<typeof terminalEventSchema>;
