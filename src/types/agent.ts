import { z } from "zod";

export const AGENT_DRIVER_IDS = ["claude-code", "codex"] as const;
export const agentDriverIdSchema = z.enum(AGENT_DRIVER_IDS);
export type AgentDriverId = z.infer<typeof agentDriverIdSchema>;

export const PERMISSION_TIERS = [
  "plan",
  "ask",
  "accept-edits",
  "yolo",
] as const;
export const permissionTierSchema = z.enum(PERMISSION_TIERS);
export type PermissionTier = z.infer<typeof permissionTierSchema>;

export const agentUsageSchema = z.object({
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
});
export type AgentUsage = z.infer<typeof agentUsageSchema>;

/**
 * The vendor-neutral event vocabulary (atlas A1). Nothing from a vendor SDK or
 * wire protocol crosses this boundary: adapters translate into these shapes,
 * and everything downstream — manager, transcript, store, components — speaks
 * only this union. `detail` fields are one-line human summaries rendered by
 * the adapter, deliberately not structured vendor payloads.
 */
export const agentEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user-message"), text: z.string() }),
  z.object({ kind: z.literal("turn-started"), turnId: z.string() }),
  z.object({ kind: z.literal("text-delta"), text: z.string() }),
  z.object({ kind: z.literal("thinking-delta"), text: z.string() }),
  z.object({
    detail: z.string(),
    kind: z.literal("tool-started"),
    name: z.string(),
    toolId: z.string(),
  }),
  z.object({
    detail: z.string(),
    kind: z.literal("tool-finished"),
    ok: z.boolean(),
    toolId: z.string(),
  }),
  z.object({
    detail: z.string(),
    kind: z.literal("permission-request"),
    requestId: z.string(),
    toolName: z.string(),
  }),
  z.object({
    approved: z.boolean(),
    kind: z.literal("permission-resolved"),
    requestId: z.string(),
  }),
  z.object({
    costUsd: z.number().nullable(),
    kind: z.literal("turn-done"),
    stopReason: z.enum(["completed", "interrupted", "error"]),
    turnId: z.string(),
    usage: agentUsageSchema.nullable(),
  }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);
export type AgentEvent = z.infer<typeof agentEventSchema>;

export const agentConfigSchema = z.object({
  driverId: agentDriverIdSchema,
  tier: permissionTierSchema,
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;

/** One line of the on-disk NDJSON transcript. */
export const transcriptLineSchema = z.object({
  at: z.number(),
  event: agentEventSchema,
});
export type TranscriptLine = z.infer<typeof transcriptLineSchema>;
