import { eventIterator, ORPCError, os } from "@orpc/server";
import { z } from "zod";
import { terminalEventSchema } from "@/types/terminal";
import {
  ensureSession,
  kill,
  killUnder,
  resize,
  restart,
  snapshotOf,
  subscribe,
  unsubscribe,
  writeTo,
} from "./manager";

const sizeInput = z.object({
  columns: z.number().int().min(2).max(1000),
  rows: z.number().int().min(1).max(1000),
});

const attachInput = sizeInput.extend({
  /** The worktree directory: both the session key and the shell's cwd. */
  worktreePath: z.string().min(1),
});

function asClientError(error: unknown): never {
  throw new ORPCError("BAD_REQUEST", {
    cause: error,
    message:
      error instanceof Error ? error.message : "The terminal could not start.",
  });
}

/**
 * Streams one worktree's shell. Replays the scrollback first, so re-opening the
 * tab shows what already happened rather than a blank screen.
 */
export const attach = os
  .input(attachInput)
  .output(eventIterator(terminalEventSchema))
  .handler(async function* ({ input, signal }) {
    // Subscribe before spawning: output produced during startup then has
    // somewhere to go instead of being dropped on the floor.
    const queue = subscribe(input.worktreePath);

    try {
      await ensureSession(input.worktreePath, {
        columns: input.columns,
        cwd: input.worktreePath,
        rows: input.rows,
      }).catch(asClientError);

      for (const event of snapshotOf(input.worktreePath)) {
        yield event;
      }
      for await (const event of queue.iterate(signal)) {
        yield event;
      }
    } finally {
      unsubscribe(input.worktreePath, queue);
    }
  });

export const write = os
  .input(z.object({ data: z.string(), worktreePath: z.string().min(1) }))
  .output(z.object({ delivered: z.boolean() }))
  .handler(({ input }) => ({
    delivered: writeTo(input.worktreePath, input.data),
  }));

export const resizeTerminal = os
  .input(attachInput)
  .output(z.object({ ok: z.boolean() }))
  .handler(({ input }) => ({
    ok: resize(input.worktreePath, input.columns, input.rows),
  }));

export const killTerminal = os
  .input(z.object({ worktreePath: z.string().min(1) }))
  .output(z.object({ ok: z.literal(true) }))
  .handler(({ input }) => {
    kill(input.worktreePath);
    return { ok: true as const };
  });

export const restartTerminal = os
  .input(attachInput)
  .output(z.object({ ok: z.literal(true) }))
  .handler(async ({ input }) => {
    await restart(input.worktreePath, {
      columns: input.columns,
      cwd: input.worktreePath,
      rows: input.rows,
    }).catch(asClientError);
    return { ok: true as const };
  });

/** Used when a project tab closes, so no shell is left behind. */
export const killUnderPath = os
  .input(z.object({ prefix: z.string().min(1) }))
  .output(z.object({ ok: z.literal(true) }))
  .handler(({ input }) => {
    killUnder(input.prefix);
    return { ok: true as const };
  });
