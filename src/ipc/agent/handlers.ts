import { eventIterator, os } from "@orpc/server";
import { z } from "zod";
import { agentConfigSchema, agentEventSchema } from "@/types/agent";
import {
  attachAgent,
  detachAgent,
  getConfig,
  interruptTurn,
  readHistory,
  respondPermission,
  send,
  setConfig,
} from "./manager";

const worktreeInput = z.object({ worktreePath: z.string().min(1) });

/**
 * Streams one worktree's agent conversation: what already happened in the
 * active turn first, then live events, until the renderer aborts. Same
 * discipline as terminal attach — the turn does not care who is watching.
 */
export const attach = os
  .input(worktreeInput)
  .output(eventIterator(agentEventSchema))
  .handler(async function* ({ input, signal }) {
    const { queue, replay } = attachAgent(input.worktreePath);
    try {
      for (const event of replay) {
        yield event;
      }
      for await (const event of queue.iterate(signal)) {
        yield event;
      }
    } finally {
      detachAgent(input.worktreePath, queue);
    }
  });

export const sendMessage = os
  .input(worktreeInput.extend({ text: z.string() }))
  .output(z.object({ accepted: z.boolean(), reason: z.string().optional() }))
  .handler(({ input }) => send(input.worktreePath, input.text));

export const interrupt = os
  .input(worktreeInput)
  .output(z.object({ ok: z.literal(true) }))
  .handler(async ({ input }) => {
    await interruptTurn(input.worktreePath);
    return { ok: true as const };
  });

export const respondPermissionRoute = os
  .input(
    worktreeInput.extend({
      approved: z.boolean(),
      requestId: z.string().min(1),
    })
  )
  .output(z.object({ ok: z.boolean() }))
  .handler(({ input }) => ({
    ok: respondPermission(input.worktreePath, input.requestId, input.approved),
  }));

export const getAgentConfig = os
  .input(worktreeInput)
  .output(
    z.object({
      config: agentConfigSchema,
      hasConversation: z.boolean(),
      turnActive: z.boolean(),
    })
  )
  .handler(({ input }) => getConfig(input.worktreePath));

export const setAgentConfig = os
  .input(worktreeInput.extend({ config: agentConfigSchema }))
  .output(z.object({ ok: z.literal(true) }))
  .handler(async ({ input }) => {
    await setConfig(input.worktreePath, input.config);
    return { ok: true as const };
  });

export const history = os
  .input(worktreeInput)
  .output(z.array(agentEventSchema))
  .handler(({ input }) => readHistory(input.worktreePath));
