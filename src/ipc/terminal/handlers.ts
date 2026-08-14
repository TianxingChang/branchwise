import { eventIterator, ORPCError, os } from "@orpc/server";
import { z } from "zod";
import { terminalKey } from "@/lib/terminal/identity";
import { terminalEventSchema } from "@/types/terminal";
import {
  ensureSession,
  kill,
  killUnder,
  resize,
  restart,
  snapshotOf,
  subscribe,
  terminalIdsFor,
  unsubscribe,
  writeTo,
} from "./manager";

const sizeInput = z.object({
  columns: z.number().int().min(2).max(1000),
  rows: z.number().int().min(1).max(1000),
});

/**
 * A worktree has as many shells as the user opens, so the directory alone no
 * longer names one. The pair is composed into a session key rather than sent
 * pre-composed: the separator is an implementation detail of the key, and the
 * renderer has no business knowing it.
 */
const targetInput = z.object({
  terminalId: z.string().min(1).max(64),
  /** The worktree directory: the shell's cwd, and half of the session key. */
  worktreePath: z.string().min(1),
});

const attachInput = targetInput.extend(sizeInput.shape);

function asClientError(error: unknown): never {
  throw new ORPCError("BAD_REQUEST", {
    cause: error,
    message:
      error instanceof Error ? error.message : "The terminal could not start.",
  });
}

/**
 * Streams one terminal's shell. Replays the scrollback first, so re-opening
 * the tab shows what already happened rather than a blank screen.
 */
export const attach = os
  .input(attachInput)
  .output(eventIterator(terminalEventSchema))
  .handler(async function* ({ input, signal }) {
    const key = terminalKey(input.worktreePath, input.terminalId);

    // Subscribe before spawning: output produced during startup then has
    // somewhere to go instead of being dropped on the floor.
    const queue = subscribe(key);

    try {
      await ensureSession(key, {
        columns: input.columns,
        cwd: input.worktreePath,
        rows: input.rows,
      }).catch(asClientError);

      for (const event of snapshotOf(key)) {
        yield event;
      }
      for await (const event of queue.iterate(signal)) {
        yield event;
      }
    } finally {
      unsubscribe(key, queue);
    }
  });

export const write = os
  .input(targetInput.extend({ data: z.string() }))
  .output(z.object({ delivered: z.boolean() }))
  .handler(({ input }) => ({
    delivered: writeTo(
      terminalKey(input.worktreePath, input.terminalId),
      input.data
    ),
  }));

export const resizeTerminal = os
  .input(attachInput)
  .output(z.object({ ok: z.boolean() }))
  .handler(({ input }) => ({
    ok: resize(
      terminalKey(input.worktreePath, input.terminalId),
      input.columns,
      input.rows
    ),
  }));

export const killTerminal = os
  .input(targetInput)
  .output(z.object({ ok: z.literal(true) }))
  .handler(({ input }) => {
    kill(terminalKey(input.worktreePath, input.terminalId));
    return { ok: true as const };
  });

export const restartTerminal = os
  .input(attachInput)
  .output(z.object({ ok: z.literal(true) }))
  .handler(async ({ input }) => {
    await restart(terminalKey(input.worktreePath, input.terminalId), {
      columns: input.columns,
      cwd: input.worktreePath,
      rows: input.rows,
    }).catch(asClientError);
    return { ok: true as const };
  });

/**
 * Which terminals a worktree currently has, oldest first. The renderer rebuilds
 * its strip from this after a remount instead of keeping a list that the main
 * process could have outlived.
 */
export const listTerminals = os
  .input(z.object({ worktreePath: z.string().min(1) }))
  .output(z.object({ terminalIds: z.array(z.string()) }))
  .handler(({ input }) => ({
    terminalIds: terminalIdsFor(input.worktreePath),
  }));

/** Used when a project tab closes, so no shell is left behind. */
export const killUnderPath = os
  .input(z.object({ prefix: z.string().min(1) }))
  .output(z.object({ ok: z.literal(true) }))
  .handler(({ input }) => {
    killUnder(input.prefix);
    return { ok: true as const };
  });
