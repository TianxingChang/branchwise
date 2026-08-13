import { eventIterator, os } from "@orpc/server";
import { z } from "zod";
import { agentKey, FIRST_CONVERSATION } from "@/lib/agent/identity";
import { agentConfigSchema, agentEventSchema } from "@/types/agent";
import {
  attachAgent,
  detachAgent,
  getConfig,
  interruptTurn,
  prepareInheritance,
  readHistory,
  respondPermission,
  send,
  setConfig,
} from "./manager";

/**
 * Which conversation, in which worktree.
 *
 * The id is optional so that anything still sending only a path lands on the
 * conversation the worktree has always had, whose key is that bare path — the
 * same compatibility rule agentKey applies.
 */
const worktreeInput = z.object({
  conversationId: z.string().min(1).max(64).default(FIRST_CONVERSATION),
  worktreePath: z.string().min(1),
});

/** The session key for a request. */
function keyOf(input: {
  conversationId: string;
  worktreePath: string;
}): string {
  return agentKey(input.worktreePath, input.conversationId);
}

/**
 * Streams one worktree's agent conversation: what already happened in the
 * active turn first, then live events, until the renderer aborts. Same
 * discipline as terminal attach — the turn does not care who is watching.
 */
export const attach = os
  .input(worktreeInput)
  .output(eventIterator(agentEventSchema))
  .handler(async function* ({ input, signal }) {
    const { queue, replay } = attachAgent(keyOf(input));
    try {
      for (const event of replay) {
        yield event;
      }
      for await (const event of queue.iterate(signal)) {
        yield event;
      }
    } finally {
      detachAgent(keyOf(input), queue);
    }
  });

export const sendMessage = os
  .input(worktreeInput.extend({ text: z.string() }))
  .output(z.object({ accepted: z.boolean(), reason: z.string().optional() }))
  .handler(({ input }) => send(keyOf(input), input.worktreePath, input.text));

export const interrupt = os
  .input(worktreeInput)
  .output(z.object({ ok: z.literal(true) }))
  .handler(async ({ input }) => {
    await interruptTurn(keyOf(input));
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
    ok: respondPermission(keyOf(input), input.requestId, input.approved),
  }));

export const getAgentConfig = os
  .input(worktreeInput)
  .output(
    z.object({
      config: agentConfigSchema,
      hasConversation: z.boolean(),
      inherited: z
        .object({
          at: z.number(),
          from: z.string(),
          mode: z.enum(["brief", "full"]),
          parentLabel: z.string().optional(),
        })
        .nullable(),
      turnActive: z.boolean(),
    })
  )
  .handler(async ({ input }) => {
    const result = await getConfig(keyOf(input));
    return {
      config: result.config,
      hasConversation: result.hasConversation,
      inherited: result.inherited ?? null,
      turnActive: result.turnActive,
    };
  });

export const setAgentConfig = os
  .input(worktreeInput.extend({ config: agentConfigSchema }))
  .output(z.object({ ok: z.literal(true) }))
  .handler(async ({ input }) => {
    await setConfig(keyOf(input), input.config);
    return { ok: true as const };
  });

export const prepareInheritanceRoute = os
  .input(
    z.object({
      childWorktree: z.string().min(1),
      mode: z.enum(["brief", "full"]),
      parentLabel: z.string().min(1),
      parentWorktree: z.string().min(1),
    })
  )
  .output(z.object({ ok: z.boolean(), reason: z.string().optional() }))
  .handler(({ input }) =>
    prepareInheritance({
      childWorktree: input.childWorktree,
      mode: input.mode,
      parentLabel: input.parentLabel,
      parentWorktree: input.parentWorktree,
    })
  );

export const history = os
  .input(worktreeInput)
  .output(z.array(agentEventSchema))
  .handler(({ input }) => readHistory(keyOf(input)));
