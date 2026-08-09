# Agent Runtime (Claude Code + Codex) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the canned Agent tab with real, streaming conversations against the user's own `claude` and `codex` CLIs, one session per worktree, with UI-routed permission approvals, resume across app restarts, and clean process teardown.

**Architecture:** A vendor-neutral `AgentEvent` vocabulary and `AgentDriver` SPI in the main process (atlas A1); a per-worktree `AgentSessionManager` shaped like the existing terminal manager (subscribe → replay → live over oRPC `eventIterator`); a Claude adapter on `@anthropic-ai/claude-agent-sdk` pointed at the user's binary, and a Codex adapter on a long-lived `codex app-server --stdio` JSON-RPC child. Renderer folds events into whole-message conversation items via one pure reducer shared by live streaming and transcript rebuild.

**Tech Stack:** Electron + oRPC over MessagePort (existing), zod 4, zustand 5, React 19, vitest (jsdom, `src/tests/unit`), `@anthropic-ai/claude-agent-sdk` (new, pinned exact), user-installed `codex` CLI (app-server JSON-RPC protocol).

**Spec:** `docs/superpowers/specs/2026-08-09-agent-runtime-design.md`. This plan covers increment 1 only; worktree context inheritance (increment 2) gets its own plan after this lands.

## Global Constraints

- Never run a real agent in tests or CI. Fixture scripts only (atlas A2).
- `src/stores` and `src/components` must not import vendor SDK/protocol types — enforced by a test (Task 11).
- Agent transcripts and registry live under `app.getPath("userData")/agent/`, never inside any repository (ADR, settled).
- Env for Claude children strips `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_PREFIX`; cwd is always the worktree path.
- Permission tiers: `plan | ask | accept-edits | yolo`; default `accept-edits`; yolo is per-node explicit, never a default.
- Claude tier → `permissionMode`: plan→`plan`, ask→`default`, accept-edits→`acceptEdits`, yolo→`bypassPermissions` + `allowDangerouslySkipPermissions: true`.
- Codex tier → thread config: plan→`{sandbox:"read-only", approvalPolicy:"on-request"}`, ask→`{sandbox:"workspace-write", approvalPolicy:"untrusted"}`, accept-edits→`{sandbox:"workspace-write", approvalPolicy:"on-request"}`, yolo→`{sandbox:"danger-full-access", approvalPolicy:"never"}`.
- Codex approval decisions on the wire: `"accept"` / `"decline"` (we never send `acceptForSession`, `cancel`, or amendment forms in v1).
- Install the SDK with `npm install -E @anthropic-ai/claude-agent-sdk` (exact pin, like canvas) and add it to `vite.main.config.mts` externals.
- Style: existing repo idiom — biome/ultracite, `expose()`-style error surfacing in handlers, `EventQueue` from `@/lib/queue` for fan-out.
- Definition of done per task: named tests pass. Definition of done for the plan: `npx tsc --noEmit --skipLibCheck` clean, `npx vitest run` green, `npm run package` succeeds.

---

### Task 1: Vocabulary — `AgentEvent` schema and the fold reducer

**Files:**
- Create: `src/types/agent.ts`
- Create: `src/lib/agent/fold.ts`
- Test: `src/tests/unit/agent-events.test.ts`
- Test: `src/tests/unit/agent-fold.test.ts`

**Interfaces:**
- Consumes: nothing (leaf task).
- Produces: `AGENT_DRIVER_IDS`, `agentDriverIdSchema`, `AgentDriverId`; `PERMISSION_TIERS`, `permissionTierSchema`, `PermissionTier`; `agentEventSchema`, `AgentEvent`; `agentConfigSchema`, `AgentConfig`; `ConversationItem`, `ConversationState`, `emptyConversation()`, `foldEvent(state, event): ConversationState` (pure, returns new state).

- [ ] **Step 1: Write the failing tests**

`src/tests/unit/agent-events.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { agentEventSchema } from "@/types/agent";

describe("agentEventSchema", () => {
  test("parses every event kind", () => {
    const events = [
      { kind: "user-message", text: "do the thing" },
      { kind: "turn-started", turnId: "t1" },
      { kind: "text-delta", text: "hel" },
      { kind: "thinking-delta", text: "hmm" },
      { kind: "tool-started", toolId: "u1", name: "Bash", detail: "npm test" },
      { kind: "tool-finished", toolId: "u1", ok: true, detail: "153 passed" },
      {
        kind: "permission-request",
        requestId: "r1",
        toolName: "Bash",
        detail: "rm -rf node_modules",
      },
      { kind: "permission-resolved", requestId: "r1", approved: false },
      {
        kind: "turn-done",
        turnId: "t1",
        stopReason: "completed",
        costUsd: 0.42,
        usage: { inputTokens: 1200, outputTokens: 340 },
      },
      { kind: "error", message: "codex is not installed" },
    ];
    for (const event of events) {
      expect(agentEventSchema.parse(event)).toEqual(event);
    }
  });

  test("rejects an unknown kind", () => {
    expect(() => agentEventSchema.parse({ kind: "nope" })).toThrow();
  });
});
```

`src/tests/unit/agent-fold.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { emptyConversation, foldEvent } from "@/lib/agent/fold";
import type { AgentEvent } from "@/types/agent";

function foldAll(events: AgentEvent[]) {
  return events.reduce(foldEvent, emptyConversation());
}

describe("foldEvent", () => {
  test("commits a whole assistant message only at turn-done", () => {
    const mid = foldAll([
      { kind: "user-message", text: "hi" },
      { kind: "turn-started", turnId: "t1" },
      { kind: "text-delta", text: "he" },
      { kind: "text-delta", text: "llo" },
    ]);
    // Streaming text is buffered, not an item (A4-lite).
    expect(mid.items).toHaveLength(1);
    expect(mid.items[0]).toMatchObject({ kind: "user", text: "hi" });
    expect(mid.streamingText).toBe("hello");
    expect(mid.activeTurnId).toBe("t1");

    const done = foldEvent(mid, {
      kind: "turn-done",
      turnId: "t1",
      stopReason: "completed",
      costUsd: 0.1,
      usage: null,
    });
    expect(done.items).toHaveLength(2);
    expect(done.items[1]).toMatchObject({
      costUsd: 0.1,
      kind: "assistant",
      text: "hello",
    });
    expect(done.streamingText).toBe("");
    expect(done.activeTurnId).toBeNull();
  });

  test("tool and permission items are whole items updated in place", () => {
    const state = foldAll([
      { kind: "turn-started", turnId: "t1" },
      { kind: "tool-started", toolId: "u1", name: "Bash", detail: "ls" },
      {
        kind: "permission-request",
        requestId: "r1",
        toolName: "Write",
        detail: "src/a.ts",
      },
      { kind: "permission-resolved", requestId: "r1", approved: true },
      { kind: "tool-finished", toolId: "u1", ok: false, detail: "exit 1" },
    ]);
    expect(state.items).toMatchObject([
      { detail: "ls", kind: "tool", name: "Bash", state: "error" },
      { kind: "permission", requestId: "r1", state: "approved" },
    ]);
  });

  test("interrupted turn with buffered text still commits the partial message", () => {
    const state = foldAll([
      { kind: "turn-started", turnId: "t1" },
      { kind: "text-delta", text: "half a thou" },
      {
        kind: "turn-done",
        turnId: "t1",
        stopReason: "interrupted",
        costUsd: null,
        usage: null,
      },
    ]);
    expect(state.items.at(-1)).toMatchObject({
      kind: "assistant",
      stopReason: "interrupted",
      text: "half a thou",
    });
  });

  test("a tool-only turn still commits a turn marker carrying cost", () => {
    const state = foldAll([
      { kind: "turn-started", turnId: "t1" },
      { kind: "tool-started", toolId: "u1", name: "Bash", detail: "npm test" },
      { kind: "tool-finished", toolId: "u1", ok: true, detail: "ok" },
      {
        kind: "turn-done",
        turnId: "t1",
        stopReason: "completed",
        costUsd: 0.05,
        usage: null,
      },
    ]);
    expect(state.items.at(-1)).toMatchObject({
      costUsd: 0.05,
      kind: "assistant",
      stopReason: "completed",
      text: "",
    });
  });

  test("error event becomes a notice item", () => {
    const state = foldAll([{ kind: "error", message: "spawn failed" }]);
    expect(state.items[0]).toMatchObject({ kind: "notice", text: "spawn failed" });
  });

  test("ids are deterministic so transcript replay reproduces identical items", () => {
    const events: AgentEvent[] = [
      { kind: "user-message", text: "a" },
      { kind: "turn-started", turnId: "t1" },
      { kind: "text-delta", text: "b" },
      { kind: "turn-done", turnId: "t1", stopReason: "completed", costUsd: null, usage: null },
    ];
    expect(foldAll(events)).toEqual(foldAll(events));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/tests/unit/agent-events.test.ts src/tests/unit/agent-fold.test.ts`
Expected: FAIL — modules `@/types/agent` (new exports) and `@/lib/agent/fold` do not exist.

- [ ] **Step 3: Write the implementation**

`src/types/agent.ts`:

```ts
import { z } from "zod";

export const AGENT_DRIVER_IDS = ["claude-code", "codex"] as const;
export const agentDriverIdSchema = z.enum(AGENT_DRIVER_IDS);
export type AgentDriverId = z.infer<typeof agentDriverIdSchema>;

export const PERMISSION_TIERS = ["plan", "ask", "accept-edits", "yolo"] as const;
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
```

`src/lib/agent/fold.ts`:

```ts
import type { AgentEvent, AgentUsage } from "@/types/agent";

export type ConversationItem =
  | { id: string; kind: "user"; text: string }
  | {
      costUsd: number | null;
      id: string;
      kind: "assistant";
      stopReason: "completed" | "interrupted" | "error";
      text: string;
      thinking: string;
      usage: AgentUsage | null;
    }
  | {
      detail: string;
      id: string;
      kind: "tool";
      name: string;
      state: "running" | "ok" | "error";
      result: string;
    }
  | {
      detail: string;
      id: string;
      kind: "permission";
      requestId: string;
      state: "pending" | "approved" | "denied";
      toolName: string;
    }
  | { id: string; kind: "notice"; text: string };

export interface ConversationState {
  activeTurnId: string | null;
  items: ConversationItem[];
  /** Monotonic counter so replaying the same events yields the same ids. */
  seq: number;
  streamingText: string;
  streamingThinking: string;
}

export function emptyConversation(): ConversationState {
  return {
    activeTurnId: null,
    items: [],
    seq: 0,
    streamingText: "",
    streamingThinking: "",
  };
}

function withItem(
  state: ConversationState,
  item: ConversationItem
): ConversationState {
  return { ...state, items: [...state.items, item], seq: state.seq + 1 };
}

function updateItem(
  state: ConversationState,
  match: (item: ConversationItem) => boolean,
  update: (item: ConversationItem) => ConversationItem
): ConversationState {
  return {
    ...state,
    items: state.items.map((item) => (match(item) ? update(item) : item)),
  };
}

/**
 * Folds one AgentEvent into conversation state. Pure and deterministic: the
 * live stream and the persisted transcript run through the same function, so
 * a restart rebuilds exactly what the user was looking at. Streaming text
 * stays out of `items` until turn-done (A4-lite: items grow only by whole
 * messages).
 */
export function foldEvent(
  state: ConversationState,
  event: AgentEvent
): ConversationState {
  switch (event.kind) {
    case "user-message":
      return withItem(state, {
        id: `i${state.seq}`,
        kind: "user",
        text: event.text,
      });

    case "turn-started":
      return {
        ...state,
        activeTurnId: event.turnId,
        streamingText: "",
        streamingThinking: "",
      };

    case "text-delta":
      return { ...state, streamingText: state.streamingText + event.text };

    case "thinking-delta":
      return {
        ...state,
        streamingThinking: state.streamingThinking + event.text,
      };

    case "tool-started":
      return withItem(state, {
        detail: event.detail,
        id: `tool-${event.toolId}`,
        kind: "tool",
        name: event.name,
        result: "",
        state: "running",
      });

    case "tool-finished":
      return updateItem(
        state,
        (item) => item.kind === "tool" && item.id === `tool-${event.toolId}`,
        (item) =>
          item.kind === "tool"
            ? { ...item, result: event.detail, state: event.ok ? "ok" : "error" }
            : item
      );

    case "permission-request":
      return withItem(state, {
        detail: event.detail,
        id: `perm-${event.requestId}`,
        kind: "permission",
        requestId: event.requestId,
        state: "pending",
        toolName: event.toolName,
      });

    case "permission-resolved":
      return updateItem(
        state,
        (item) =>
          item.kind === "permission" && item.requestId === event.requestId,
        (item) =>
          item.kind === "permission"
            ? { ...item, state: event.approved ? "approved" : "denied" }
            : item
      );

    case "turn-done": {
      // Every turn ends with a committed marker item, even when the model
      // produced no prose: it is the one place cost, usage and the stop
      // reason live (a tool-only turn would otherwise drop them all).
      const done = withItem(state, {
        costUsd: event.costUsd,
        id: `turn-${event.turnId}`,
        kind: "assistant",
        stopReason: event.stopReason,
        text: state.streamingText,
        thinking: state.streamingThinking,
        usage: event.usage,
      });
      return {
        ...done,
        activeTurnId: null,
        streamingText: "",
        streamingThinking: "",
      };
    }

    case "error":
      return withItem(state, {
        id: `i${state.seq}`,
        kind: "notice",
        text: event.message,
      });

    default:
      return state;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/tests/unit/agent-events.test.ts src/tests/unit/agent-fold.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types/agent.ts src/lib/agent/fold.ts src/tests/unit/agent-events.test.ts src/tests/unit/agent-fold.test.ts
git commit -m "Define the agent event vocabulary and the conversation fold"
```

---

### Task 2: Persistence — transcript NDJSON and the session registry

**Files:**
- Create: `src/ipc/agent/transcript.ts`
- Create: `src/ipc/agent/registry.ts`
- Test: `src/tests/unit/agent-transcript.test.ts`
- Test: `src/tests/unit/agent-registry.test.ts`

**Interfaces:**
- Consumes: `AgentEvent`, `transcriptLineSchema`, `AgentConfig`, `agentDriverIdSchema`, `permissionTierSchema` from Task 1.
- Produces:
  - `transcript.ts`: `worktreeHash(worktreePath: string): string`; `appendTranscript(baseDir: string, worktreePath: string, event: AgentEvent): Promise<void>`; `readTranscript(baseDir: string, worktreePath: string, limit?: number): Promise<AgentEvent[]>`.
  - `registry.ts`: `loadRegistry(baseDir: string): Promise<AgentRegistry>`; `saveRegistry(baseDir: string, registry: AgentRegistry): Promise<void>`; `agentRegistrySchema`; `AgentRegistry` = `{ version: 1; lastDriverId: AgentDriverId; worktrees: Record<string, WorktreeAgentState> }` with `WorktreeAgentState` = `{ driverId; tier; sessionId: string | null; threadId: string | null; updatedAt: number }`.
- Both modules take `baseDir` as a parameter (tests pass a temp dir; the manager passes `app.getPath("userData")/agent`). Neither imports `electron`.

- [ ] **Step 1: Write the failing tests**

`src/tests/unit/agent-transcript.test.ts`:

```ts
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  appendTranscript,
  readTranscript,
  worktreeHash,
} from "@/ipc/agent/transcript";
import type { AgentEvent } from "@/types/agent";

let base = "";
beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "bw-transcript-"));
});
afterEach(async () => {
  await rm(base, { force: true, recursive: true });
});

const WT = "/tmp/repo.worktrees/feat-a";

describe("transcript", () => {
  test("hash is stable and filename-safe", () => {
    expect(worktreeHash(WT)).toBe(worktreeHash(WT));
    expect(worktreeHash(WT)).toMatch(/^[a-f0-9]{16}$/);
    expect(worktreeHash("/other")).not.toBe(worktreeHash(WT));
  });

  test("appends then reads back in order", async () => {
    const events: AgentEvent[] = [
      { kind: "user-message", text: "one" },
      { kind: "turn-started", turnId: "t1" },
      {
        kind: "turn-done",
        turnId: "t1",
        stopReason: "completed",
        costUsd: null,
        usage: null,
      },
    ];
    for (const event of events) {
      await appendTranscript(base, WT, event);
    }
    expect(await readTranscript(base, WT)).toEqual(events);
  });

  test("tolerates a torn final line", async () => {
    await appendTranscript(base, WT, { kind: "user-message", text: "ok" });
    const file = path.join(base, "transcripts", `${worktreeHash(WT)}.ndjson`);
    await appendFile(file, '{"at":123,"event":{"kind":"text-de', "utf8");
    expect(await readTranscript(base, WT)).toEqual([
      { kind: "user-message", text: "ok" },
    ]);
  });

  test("missing transcript reads as empty", async () => {
    expect(await readTranscript(base, "/never/seen")).toEqual([]);
  });

  test("limit keeps only the newest events", async () => {
    for (let i = 0; i < 5; i += 1) {
      await appendTranscript(base, WT, { kind: "user-message", text: `${i}` });
    }
    const events = await readTranscript(base, WT, 2);
    expect(events).toEqual([
      { kind: "user-message", text: "3" },
      { kind: "user-message", text: "4" },
    ]);
  });
});
```

`src/tests/unit/agent-registry.test.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadRegistry, saveRegistry } from "@/ipc/agent/registry";

let base = "";
beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "bw-registry-"));
});
afterEach(async () => {
  await rm(base, { force: true, recursive: true });
});

describe("agent registry", () => {
  test("missing file loads as an empty registry", async () => {
    const registry = await loadRegistry(base);
    expect(registry).toEqual({
      lastDriverId: "claude-code",
      version: 1,
      worktrees: {},
    });
  });

  test("round-trips and writes atomically (no partial file left behind)", async () => {
    const registry = await loadRegistry(base);
    registry.worktrees["/wt/a"] = {
      driverId: "codex",
      sessionId: null,
      threadId: "th_1",
      tier: "accept-edits",
      updatedAt: 111,
    };
    registry.lastDriverId = "codex";
    await saveRegistry(base, registry);
    expect(await loadRegistry(base)).toEqual(registry);
    const raw = await readFile(path.join(base, "registry.json"), "utf8");
    expect(JSON.parse(raw).version).toBe(1);
  });

  test("a corrupt file loads as empty rather than throwing (and is not overwritten until save)", async () => {
    const file = path.join(base, "registry.json");
    await writeFile(file, "{not json", "utf8");
    expect(await loadRegistry(base)).toEqual({
      lastDriverId: "claude-code",
      version: 1,
      worktrees: {},
    });
    // Load alone must not clobber the unreadable file (F5 lesson: an
    // unreadable file must not become a deleted file).
    expect(await readFile(file, "utf8")).toBe("{not json");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/tests/unit/agent-transcript.test.ts src/tests/unit/agent-registry.test.ts`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Write the implementation**

`src/ipc/agent/transcript.ts`:

```ts
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  type AgentEvent,
  type TranscriptLine,
  transcriptLineSchema,
} from "@/types/agent";

/** Short, filename-safe, stable identity for a worktree's transcript file. */
export function worktreeHash(worktreePath: string): string {
  return createHash("sha256")
    .update(path.resolve(worktreePath))
    .digest("hex")
    .slice(0, 16);
}

function transcriptFile(baseDir: string, worktreePath: string): string {
  return path.join(baseDir, "transcripts", `${worktreeHash(worktreePath)}.ndjson`);
}

export async function appendTranscript(
  baseDir: string,
  worktreePath: string,
  event: AgentEvent
): Promise<void> {
  const file = transcriptFile(baseDir, worktreePath);
  await mkdir(path.dirname(file), { recursive: true });
  const line: TranscriptLine = { at: Date.now(), event };
  await appendFile(file, `${JSON.stringify(line)}\n`, "utf8");
}

/**
 * Reads a transcript back as events, newest-last. A torn final line — the app
 * died mid-append — parses as nothing rather than poisoning the rebuild.
 */
export async function readTranscript(
  baseDir: string,
  worktreePath: string,
  limit = 2000
): Promise<AgentEvent[]> {
  let raw: string;
  try {
    raw = await readFile(transcriptFile(baseDir, worktreePath), "utf8");
  } catch {
    return [];
  }

  const events: AgentEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      events.push(transcriptLineSchema.parse(JSON.parse(line)).event);
    } catch {
      // Torn or foreign line: skip it, keep the rest.
    }
  }
  return events.slice(-limit);
}
```

`src/ipc/agent/registry.ts`:

```ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { agentDriverIdSchema, permissionTierSchema } from "@/types/agent";

const worktreeAgentStateSchema = z.object({
  driverId: agentDriverIdSchema,
  sessionId: z.string().nullable(),
  threadId: z.string().nullable(),
  tier: permissionTierSchema,
  updatedAt: z.number(),
});
export type WorktreeAgentState = z.infer<typeof worktreeAgentStateSchema>;

export const agentRegistrySchema = z.object({
  lastDriverId: agentDriverIdSchema,
  version: z.literal(1),
  worktrees: z.record(z.string(), worktreeAgentStateSchema),
});
export type AgentRegistry = z.infer<typeof agentRegistrySchema>;

function emptyRegistry(): AgentRegistry {
  return { lastDriverId: "claude-code", version: 1, worktrees: {} };
}

function registryFile(baseDir: string): string {
  return path.join(baseDir, "registry.json");
}

/**
 * Loading never throws and never writes: an unreadable registry is treated as
 * empty in memory, but the bytes on disk stay untouched until the next save.
 */
export async function loadRegistry(baseDir: string): Promise<AgentRegistry> {
  try {
    const raw = await readFile(registryFile(baseDir), "utf8");
    return agentRegistrySchema.parse(JSON.parse(raw));
  } catch {
    return emptyRegistry();
  }
}

/** Atomic write: temp file then rename, so a crash never leaves half a file. */
export async function saveRegistry(
  baseDir: string,
  registry: AgentRegistry
): Promise<void> {
  await mkdir(baseDir, { recursive: true });
  const file = registryFile(baseDir);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(registry, null, 2), "utf8");
  await rename(tmp, file);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/tests/unit/agent-transcript.test.ts src/tests/unit/agent-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ipc/agent/transcript.ts src/ipc/agent/registry.ts src/tests/unit/agent-transcript.test.ts src/tests/unit/agent-registry.test.ts
git commit -m "Persist agent registry and transcripts under app support"
```

---

### Task 3: Executable resolution (shared helper + Claude wrapper)

**Files:**
- Create: `src/ipc/agent/find-executable.ts` (shared with Task 7's codex resolver — the search logic exists once)
- Create: `src/ipc/claude/executable.ts`
- Test: `src/tests/unit/claude-executable.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `find-executable.ts`: `findExecutable(input: { binaryName: string; env: NodeJS.ProcessEnv; envOverride?: string; extraCandidates: string[] }): Promise<string | null>` — checks the env-override path, then `extraCandidates`, then each `PATH` directory joined with `binaryName`. Absolute, executable paths only; never throws.
  - `executable.ts`: `resolveClaudeExecutable(env?: NodeJS.ProcessEnv, systemCandidates?: string[]): Promise<string | null>` — thin wrapper over `findExecutable`. Search order: `CLAUDE_BIN` env override → `~/.local/bin/claude` → `~/.claude/local/claude` → system candidates (default `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`) → first hit on `PATH`. The system candidates are an injectable parameter so tests stay hermetic on machines that really have a brew-installed claude; production callers omit it.

- [ ] **Step 1: Write the failing test**

`src/tests/unit/claude-executable.test.ts`:

```ts
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveClaudeExecutable } from "@/ipc/claude/executable";

let base = "";
beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "bw-claude-bin-"));
});
afterEach(async () => {
  await rm(base, { force: true, recursive: true });
});

async function fakeBinary(name: string): Promise<string> {
  const file = path.join(base, name);
  await writeFile(file, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(file, 0o755);
  return file;
}

describe("resolveClaudeExecutable", () => {
  // systemCandidates is [] throughout: the default brew paths are real
  // machine state these tests must not depend on.
  test("CLAUDE_BIN override wins when it exists", async () => {
    const bin = await fakeBinary("claude");
    expect(
      await resolveClaudeExecutable(
        { CLAUDE_BIN: bin, HOME: base, PATH: "" },
        []
      )
    ).toBe(bin);
  });

  test("a CLAUDE_BIN pointing nowhere is ignored, PATH is searched", async () => {
    const bin = await fakeBinary("claude");
    const resolved = await resolveClaudeExecutable(
      { CLAUDE_BIN: path.join(base, "missing"), HOME: base, PATH: base },
      []
    );
    expect(resolved).toBe(bin);
  });

  test("an injected system candidate beats PATH", async () => {
    const system = await fakeBinary("claude");
    const resolved = await resolveClaudeExecutable(
      { HOME: path.join(base, "nohome"), PATH: "" },
      [system]
    );
    expect(resolved).toBe(system);
  });

  test("returns null when nothing is installed", async () => {
    expect(
      await resolveClaudeExecutable({ HOME: base, PATH: base }, [])
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/tests/unit/claude-executable.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

`src/ipc/agent/find-executable.ts`:

```ts
import { access, constants } from "node:fs/promises";
import path from "node:path";

async function executable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds a user-installed CLI. branchwise never bundles a runtime and never
 * stores credentials: the user's install carries their subscription
 * (decision 2). A Finder-launched Electron has a minimal PATH, so callers
 * pass well-known install locations to check before PATH.
 */
export async function findExecutable(input: {
  binaryName: string;
  env: NodeJS.ProcessEnv;
  envOverride?: string;
  extraCandidates: string[];
}): Promise<string | null> {
  const candidates = [input.envOverride, ...input.extraCandidates];
  for (const candidate of candidates) {
    if (candidate && path.isAbsolute(candidate) && (await executable(candidate))) {
      return candidate;
    }
  }

  for (const dir of (input.env.PATH ?? "").split(path.delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    const candidate = path.join(dir, input.binaryName);
    if (path.isAbsolute(candidate) && (await executable(candidate))) {
      return candidate;
    }
  }
  return null;
}
```

`src/ipc/claude/executable.ts`:

```ts
import path from "node:path";
import { findExecutable } from "@/ipc/agent/find-executable";

const DEFAULT_SYSTEM_CANDIDATES = [
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
];

export function resolveClaudeExecutable(
  env: NodeJS.ProcessEnv = process.env,
  // Injectable so tests never depend on what is really installed at the
  // fixed system paths on the machine running them.
  systemCandidates: string[] = DEFAULT_SYSTEM_CANDIDATES
): Promise<string | null> {
  const home = env.HOME ?? "";
  return findExecutable({
    binaryName: "claude",
    env,
    envOverride: env.CLAUDE_BIN,
    extraCandidates: [
      ...(home
        ? [
            path.join(home, ".local", "bin", "claude"),
            path.join(home, ".claude", "local", "claude"),
          ]
        : []),
      ...systemCandidates,
    ],
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/tests/unit/claude-executable.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ipc/agent/find-executable.ts src/ipc/claude/executable.ts src/tests/unit/claude-executable.test.ts
git commit -m "Resolve the user's claude binary without bundling one"
```

---

### Task 4: Driver SPI and the Claude adapter's spawn contract (cwd + env first)

**Files:**
- Create: `src/ipc/agent/driver.ts`
- Create: `src/ipc/claude/options.ts`
- Test: `src/tests/unit/claude-options.test.ts`
- Modify: `package.json` (add `@anthropic-ai/claude-agent-sdk`, exact)
- Modify: `vite.main.config.mts` (externals)

**Interfaces:**
- Consumes: Task 1 types; `resolveClaudeExecutable` (Task 3, used in Task 6).
- Produces:
  - `driver.ts`: `interface StartTurnInput { worktreePath: string; prompt: string; tier: PermissionTier; resume: { sessionId: string | null; threadId: string | null }; onSessionId: (id: string) => void; onThreadId: (id: string) => void; requestPermission: (request: { requestId: string; toolName: string; detail: string }) => Promise<boolean>; }`; `interface AgentTurnHandle { events: AsyncIterable<AgentEvent>; interrupt: () => Promise<void>; }`; `interface AgentDriver { id: AgentDriverId; startTurn: (input: StartTurnInput) => AgentTurnHandle; shutdown: () => Promise<void>; }`
  - `options.ts`: `sanitizedEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv`; `buildClaudeOptions(input: { worktreePath: string; tier: PermissionTier; resumeSessionId: string | null; executable: string; abortController: AbortController; canUseTool: CanUseToolShim }): Record<string, unknown>` where `CanUseToolShim = (toolName: string, toolInput: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<{ behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string }>`.

This is the atlas A2 test written first: the options builder is the single
place cwd, env and permission mode are decided, and it is pure, so the
correctness bug ("agent commits to the wrong branch") is pinned by unit test
before any process exists.

- [ ] **Step 1: Install the SDK and mark it external**

```bash
npm install -E @anthropic-ai/claude-agent-sdk
```

In `vite.main.config.mts` change the externals line:

```ts
      external: ["node-pty", "@anthropic-ai/claude-agent-sdk"],
```

- [ ] **Step 2: Write the failing test**

`src/tests/unit/claude-options.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { buildClaudeOptions, sanitizedEnvironment } from "@/ipc/claude/options";

const BASE = {
  abortController: new AbortController(),
  canUseTool: () => Promise.resolve({ behavior: "allow" as const }),
  executable: "/Users/me/.local/bin/claude",
  resumeSessionId: null,
  tier: "accept-edits" as const,
  worktreePath: "/repo.worktrees/feat-a",
};

describe("sanitizedEnvironment", () => {
  test("strips git redirection variables that would retarget the agent", () => {
    const env = sanitizedEnvironment({
      GIT_DIR: "/somewhere/.git",
      GIT_INDEX_FILE: "/x",
      GIT_PREFIX: "sub/",
      GIT_WORK_TREE: "/somewhere",
      HOME: "/Users/me",
      PATH: "/usr/bin",
    });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.GIT_PREFIX).toBeUndefined();
    expect(env.HOME).toBe("/Users/me");
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("buildClaudeOptions", () => {
  test("cwd is the worktree, executable is the user's binary", () => {
    const options = buildClaudeOptions(BASE);
    expect(options.cwd).toBe("/repo.worktrees/feat-a");
    expect(options.pathToClaudeCodeExecutable).toBe(
      "/Users/me/.local/bin/claude"
    );
    expect(options.includePartialMessages).toBe(true);
    expect(options.resume).toBeUndefined();
  });

  test("tier maps to the documented permission modes", () => {
    expect(buildClaudeOptions({ ...BASE, tier: "plan" }).permissionMode).toBe(
      "plan"
    );
    expect(buildClaudeOptions({ ...BASE, tier: "ask" }).permissionMode).toBe(
      "default"
    );
    expect(buildClaudeOptions(BASE).permissionMode).toBe("acceptEdits");
    const yolo = buildClaudeOptions({ ...BASE, tier: "yolo" });
    expect(yolo.permissionMode).toBe("bypassPermissions");
    expect(yolo.allowDangerouslySkipPermissions).toBe(true);
  });

  test("non-yolo tiers never set the bypass escape hatch", () => {
    expect(
      buildClaudeOptions(BASE).allowDangerouslySkipPermissions
    ).toBeUndefined();
  });

  test("resume id is passed through when present", () => {
    expect(
      buildClaudeOptions({ ...BASE, resumeSessionId: "s-123" }).resume
    ).toBe("s-123");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/tests/unit/claude-options.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Write the implementation**

`src/ipc/agent/driver.ts`:

```ts
import type { AgentDriverId, AgentEvent, PermissionTier } from "@/types/agent";

export interface StartTurnInput {
  worktreePath: string;
  prompt: string;
  tier: PermissionTier;
  resume: { sessionId: string | null; threadId: string | null };
  /** Called the moment the vendor announces a session id — before any output. */
  onSessionId: (id: string) => void;
  onThreadId: (id: string) => void;
  /**
   * The manager parks the returned promise until the user answers from the
   * panel; the adapter awaits it and translates the boolean into its vendor's
   * verdict shape.
   */
  requestPermission: (request: {
    requestId: string;
    toolName: string;
    detail: string;
  }) => Promise<boolean>;
}

export interface AgentTurnHandle {
  events: AsyncIterable<AgentEvent>;
  interrupt: () => Promise<void>;
}

export interface AgentDriver {
  id: AgentDriverId;
  startTurn: (input: StartTurnInput) => AgentTurnHandle;
  /** Kill children and drop per-process state. Called on app quit. */
  shutdown: () => Promise<void>;
}

export class AgentDriverError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentDriverError";
  }
}
```

`src/ipc/claude/options.ts`:

```ts
import type { PermissionTier } from "@/types/agent";

const STRIPPED_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"];

/**
 * The inherited environment minus git redirection. A GIT_DIR leaking in from
 * whatever spawned branchwise would make every agent operate on the wrong
 * repository regardless of cwd — the A2 correctness bug in env form.
 */
export function sanitizedEnvironment(
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const key of STRIPPED_ENV) {
    delete clean[key];
  }
  return clean;
}

const TIER_TO_MODE: Record<PermissionTier, string> = {
  "accept-edits": "acceptEdits",
  ask: "default",
  plan: "plan",
  yolo: "bypassPermissions",
};

export type CanUseToolShim = (
  toolName: string,
  toolInput: Record<string, unknown>,
  options: { signal: AbortSignal }
) => Promise<
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string }
>;

/**
 * Pure so the spawn contract is unit-testable: cwd, env, permission mode and
 * the resume id are decided here and nowhere else.
 */
export function buildClaudeOptions(input: {
  abortController: AbortController;
  canUseTool: CanUseToolShim;
  executable: string;
  resumeSessionId: string | null;
  tier: PermissionTier;
  worktreePath: string;
}): Record<string, unknown> {
  return {
    abortController: input.abortController,
    canUseTool: input.canUseTool,
    cwd: input.worktreePath,
    env: sanitizedEnvironment(),
    includePartialMessages: true,
    pathToClaudeCodeExecutable: input.executable,
    permissionMode: TIER_TO_MODE[input.tier],
    ...(input.tier === "yolo"
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/tests/unit/claude-options.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit --skipLibCheck` — expect clean.

```bash
git add package.json package-lock.json vite.main.config.mts src/ipc/agent/driver.ts src/ipc/claude/options.ts src/tests/unit/claude-options.test.ts
git commit -m "Pin the Claude spawn contract: worktree cwd, sanitised env, tier mapping"
```

---

### Task 5: Claude event mapper

**Files:**
- Create: `src/ipc/claude/map-events.ts`
- Test: `src/tests/unit/claude-map-events.test.ts`

**Interfaces:**
- Consumes: `AgentEvent` (Task 1).
- Produces: `mapClaudeMessage(message: unknown, turnId: string): AgentEvent[]` — a pure normaliser over *structural* shapes (no SDK type imports, so fixtures fully specify behavior and the SDK stays quarantined in the adapter). Handled shapes: system/init (returns `[]`; the adapter reads `session_id` directly), stream_event content_block_delta (`text_delta` → text-delta, `thinking_delta` → thinking-delta), assistant tool_use blocks → tool-started, user tool_result blocks → tool-finished, result → turn-done with `total_cost_usd` and usage. Everything unrecognised → `[]`.

- [ ] **Step 1: Write the failing test**

`src/tests/unit/claude-map-events.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { mapClaudeMessage } from "@/ipc/claude/map-events";

describe("mapClaudeMessage", () => {
  test("text and thinking deltas", () => {
    const message = {
      event: {
        delta: { text: "hel", type: "text_delta" },
        type: "content_block_delta",
      },
      session_id: "s1",
      type: "stream_event",
    };
    expect(mapClaudeMessage(message, "t1")).toEqual([
      { kind: "text-delta", text: "hel" },
    ]);
    const thinking = {
      event: {
        delta: { thinking: "hmm", type: "thinking_delta" },
        type: "content_block_delta",
      },
      type: "stream_event",
    };
    expect(mapClaudeMessage(thinking, "t1")).toEqual([
      { kind: "thinking-delta", text: "hmm" },
    ]);
  });

  test("assistant tool_use becomes tool-started with a one-line detail", () => {
    const message = {
      message: {
        content: [
          {
            id: "toolu_1",
            input: { command: "npm test" },
            name: "Bash",
            type: "tool_use",
          },
        ],
      },
      type: "assistant",
    };
    expect(mapClaudeMessage(message, "t1")).toEqual([
      { detail: "npm test", kind: "tool-started", name: "Bash", toolId: "toolu_1" },
    ]);
  });

  test("user tool_result becomes tool-finished, error flag respected", () => {
    const message = {
      message: {
        content: [
          {
            content: "boom",
            is_error: true,
            tool_use_id: "toolu_1",
            type: "tool_result",
          },
        ],
      },
      type: "user",
    };
    expect(mapClaudeMessage(message, "t1")).toEqual([
      { detail: "boom", kind: "tool-finished", ok: false, toolId: "toolu_1" },
    ]);
  });

  test("a multi-line command collapses to a one-line detail", () => {
    const message = {
      message: {
        content: [
          {
            id: "toolu_2",
            input: { command: "npm run build &&\nnpm test\n# done" },
            name: "Bash",
            type: "tool_use",
          },
        ],
      },
      type: "assistant",
    };
    expect(mapClaudeMessage(message, "t1")).toEqual([
      {
        detail: "npm run build && npm test # done",
        kind: "tool-started",
        name: "Bash",
        toolId: "toolu_2",
      },
    ]);
  });

  test("array-shaped tool_result content extracts its text blocks", () => {
    const message = {
      message: {
        content: [
          {
            content: [
              { text: "line one", type: "text" },
              { text: "line two", type: "text" },
            ],
            tool_use_id: "toolu_1",
            type: "tool_result",
          },
        ],
      },
      type: "user",
    };
    expect(mapClaudeMessage(message, "t1")).toEqual([
      {
        detail: "line one line two",
        kind: "tool-finished",
        ok: true,
        toolId: "toolu_1",
      },
    ]);
  });

  test("result carries cost and usage into turn-done", () => {
    const message = {
      subtype: "success",
      total_cost_usd: 0.37,
      type: "result",
      usage: { input_tokens: 1200, output_tokens: 88 },
    };
    expect(mapClaudeMessage(message, "t9")).toEqual([
      {
        costUsd: 0.37,
        kind: "turn-done",
        stopReason: "completed",
        turnId: "t9",
        usage: { inputTokens: 1200, outputTokens: 88 },
      },
    ]);
  });

  test("error result maps to error stop reason", () => {
    const message = { subtype: "error_during_execution", type: "result" };
    expect(mapClaudeMessage(message, "t9")).toEqual([
      {
        costUsd: null,
        kind: "turn-done",
        stopReason: "error",
        turnId: "t9",
        usage: null,
      },
    ]);
  });

  test("unknown message types map to nothing", () => {
    expect(mapClaudeMessage({ type: "status" }, "t1")).toEqual([]);
    expect(mapClaudeMessage(null, "t1")).toEqual([]);
    expect(mapClaudeMessage("garbage", "t1")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/tests/unit/claude-map-events.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

`src/ipc/claude/map-events.ts`:

```ts
import type { AgentEvent } from "@/types/agent";

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return value !== null && typeof value === "object" ? (value as Rec) : null;
}

/**
 * Collapses all whitespace (newlines included) and caps length. `detail`
 * fields are one-line human summaries by contract — a multi-line shell
 * command must not smuggle newlines into them.
 */
function oneLine(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

/** One line of human-readable context for a tool call, vendor payload stays here. */
function toolDetail(input: unknown): string {
  const fields = rec(input);
  if (!fields) {
    return "";
  }
  for (const key of ["command", "file_path", "path", "pattern", "url", "query"]) {
    const value = fields[key];
    if (typeof value === "string" && value.length > 0) {
      return oneLine(value);
    }
  }
  return oneLine(JSON.stringify(fields));
}

function resultText(content: unknown): string {
  if (typeof content === "string") {
    return oneLine(content);
  }
  // tool_result content can also be an array of content blocks.
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      const b = rec(block);
      if (b?.type === "text" && typeof b.text === "string") {
        texts.push(b.text);
      }
    }
    return oneLine(texts.join(" "));
  }
  return "";
}

/**
 * Normalises one SDK message into branchwise events. Structural on purpose:
 * matching on shapes rather than imported SDK types keeps the vendor boundary
 * at the adapter and makes fixtures the complete spec of this function.
 */
export function mapClaudeMessage(message: unknown, turnId: string): AgentEvent[] {
  const m = rec(message);
  if (!m) {
    return [];
  }

  if (m.type === "stream_event") {
    const event = rec(m.event);
    const delta = rec(event?.delta);
    if (event?.type === "content_block_delta" && delta) {
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        return [{ kind: "text-delta", text: delta.text }];
      }
      if (
        delta.type === "thinking_delta" &&
        typeof delta.thinking === "string"
      ) {
        return [{ kind: "thinking-delta", text: delta.thinking }];
      }
    }
    return [];
  }

  if (m.type === "assistant" || m.type === "user") {
    const content = rec(m.message)?.content;
    if (!Array.isArray(content)) {
      return [];
    }
    const events: AgentEvent[] = [];
    for (const block of content) {
      const b = rec(block);
      if (!b) {
        continue;
      }
      if (b.type === "tool_use" && typeof b.id === "string") {
        events.push({
          detail: toolDetail(b.input),
          kind: "tool-started",
          name: typeof b.name === "string" ? b.name : "tool",
          toolId: b.id,
        });
      }
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        events.push({
          detail: resultText(b.content),
          kind: "tool-finished",
          ok: b.is_error !== true,
          toolId: b.tool_use_id,
        });
      }
    }
    return events;
  }

  if (m.type === "result") {
    const usage = rec(m.usage);
    return [
      {
        costUsd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : null,
        kind: "turn-done",
        stopReason: m.subtype === "success" ? "completed" : "error",
        turnId,
        usage: usage
          ? {
              inputTokens:
                typeof usage.input_tokens === "number" ? usage.input_tokens : null,
              outputTokens:
                typeof usage.output_tokens === "number"
                  ? usage.output_tokens
                  : null,
            }
          : null,
      },
    ];
  }

  return [];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/tests/unit/claude-map-events.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ipc/claude/map-events.ts src/tests/unit/claude-map-events.test.ts
git commit -m "Normalise Claude SDK messages into the agent vocabulary"
```

---

### Task 6: Claude adapter

**Files:**
- Create: `src/ipc/claude/adapter.ts`
- Test: `src/tests/unit/claude-adapter.test.ts`

**Interfaces:**
- Consumes: `AgentDriver`, `StartTurnInput`, `AgentTurnHandle`, `AgentDriverError` (Task 4); `buildClaudeOptions`, `CanUseToolShim` (Task 4); `mapClaudeMessage` (Task 5); `resolveClaudeExecutable` (Task 3).
- Produces: `createClaudeDriver(dependencies?: { queryFactory?: ClaudeQueryFactory; resolveExecutable?: () => Promise<string | null> }): AgentDriver` with `type ClaudeQueryFactory = (params: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<unknown>`. Default `queryFactory` lazily does `const { query } = await import("@anthropic-ai/claude-agent-sdk")` — the only SDK import in the codebase.

Behavior contract (all tested through an injected fake factory — no SDK, no processes):
- Missing executable → yields `error` ("Claude Code is not installed…") + `turn-done { stopReason: "error" }`, never throws.
- `session_id` on the *first* message that carries one (init) triggers `onSessionId` before further events are yielded.
- Each SDK message flows through `mapClaudeMessage`; `turn-started` is emitted first with a fresh `turnId` (`crypto.randomUUID()`).
- `canUseTool` bridges to `input.requestPermission` with a fresh `requestId`; allow → `{ behavior: "allow" }`, deny → `{ behavior: "deny", message: "Denied from the branchwise panel." }`.
- `interrupt()` aborts the `AbortController`; the stream then ends with `turn-done { stopReason: "interrupted" }` if no result message arrived.
- The factory throwing mid-stream yields `error` + `turn-done { stopReason: "error" }`.
- If the iterable ends without a result message, a synthetic `turn-done { stopReason: "completed", costUsd: null, usage: null }` is emitted (belt for SDK versions that end cleanly).

- [ ] **Step 1: Write the failing test**

`src/tests/unit/claude-adapter.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { createClaudeDriver } from "@/ipc/claude/adapter";
import type { StartTurnInput } from "@/ipc/agent/driver";
import type { AgentEvent } from "@/types/agent";

function baseInput(overrides: Partial<StartTurnInput> = {}): StartTurnInput {
  return {
    onSessionId: () => {},
    onThreadId: () => {},
    prompt: "do it",
    requestPermission: () => Promise.resolve(true),
    resume: { sessionId: null, threadId: null },
    tier: "accept-edits",
    worktreePath: "/wt/feat-a",
    ...overrides,
  };
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) {
    out.push(event);
  }
  return out;
}

describe("claude adapter", () => {
  test("missing executable becomes an error event, not a throw", async () => {
    const driver = createClaudeDriver({
      queryFactory: () => {
        throw new Error("must not be called");
      },
      resolveExecutable: () => Promise.resolve(null),
    });
    const events = await drain(driver.startTurn(baseInput()).events);
    expect(events.at(0)?.kind).toBe("turn-started");
    expect(events.some((e) => e.kind === "error")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      kind: "turn-done",
      stopReason: "error",
    });
  });

  test("captures session_id from init before mapping, passes options through", async () => {
    const seen: string[] = [];
    let captured: Record<string, unknown> = {};
    const driver = createClaudeDriver({
      queryFactory: ({ options }) => {
        captured = options;
        return (async function* () {
          yield { session_id: "sess-9", subtype: "init", type: "system" };
          yield {
            event: {
              delta: { text: "hi", type: "text_delta" },
              type: "content_block_delta",
            },
            type: "stream_event",
          };
          yield { subtype: "success", total_cost_usd: 0.01, type: "result" };
        })();
      },
      resolveExecutable: () => Promise.resolve("/bin/claude"),
    });
    const events = await drain(
      driver.startTurn(baseInput({ onSessionId: (id) => seen.push(id) })).events
    );
    expect(seen).toEqual(["sess-9"]);
    expect(captured.cwd).toBe("/wt/feat-a");
    expect(captured.resume).toBeUndefined();
    expect(events.map((e) => e.kind)).toEqual([
      "turn-started",
      "text-delta",
      "turn-done",
    ]);
  });

  test("canUseTool routes through requestPermission and translates the verdict", async () => {
    let canUse:
      | ((
          tool: string,
          input: Record<string, unknown>,
          options: { signal: AbortSignal }
        ) => Promise<unknown>)
      | undefined;
    const asked: string[] = [];
    const driver = createClaudeDriver({
      queryFactory: ({ options }) => {
        canUse = options.canUseTool as typeof canUse;
        return (async function* () {
          yield { subtype: "success", type: "result" };
        })();
      },
      resolveExecutable: () => Promise.resolve("/bin/claude"),
    });
    const handle = driver.startTurn(
      baseInput({
        requestPermission: (request) => {
          asked.push(request.toolName);
          return Promise.resolve(false);
        },
      })
    );
    await drain(handle.events);
    expect(canUse).toBeDefined();
    const verdict = await canUse?.("Bash", { command: "rm -rf /" }, {
      signal: new AbortController().signal,
    });
    expect(asked).toEqual(["Bash"]);
    expect(verdict).toMatchObject({ behavior: "deny" });
  });

  test("interrupt aborts and closes with an interrupted turn-done", async () => {
    const driver = createClaudeDriver({
      queryFactory: ({ options }) => {
        const controller = options.abortController as AbortController;
        return (async function* () {
          yield { session_id: "s", subtype: "init", type: "system" };
          await new Promise<void>((resolve) => {
            // Interrupt may fire before this generator is ever pulled this
            // far — an abort listener added after the fact never fires, so
            // check the flag first.
            if (controller.signal.aborted) {
              resolve();
              return;
            }
            controller.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          throw new Error("aborted");
        })();
      },
      resolveExecutable: () => Promise.resolve("/bin/claude"),
    });
    const handle = driver.startTurn(baseInput());
    const drained = drain(handle.events);
    await handle.interrupt();
    const events = await drained;
    expect(events.at(-1)).toMatchObject({
      kind: "turn-done",
      stopReason: "interrupted",
    });
  });

  test("a rejecting executable resolver becomes an error event, not a throw", async () => {
    const driver = createClaudeDriver({
      queryFactory: () => {
        throw new Error("must not be called");
      },
      resolveExecutable: () => Promise.reject(new Error("resolver exploded")),
    });
    const events = await drain(driver.startTurn(baseInput()).events);
    expect(events.some((e) => e.kind === "error")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      kind: "turn-done",
      stopReason: "error",
    });
  });

  test("a stream failure after the result never emits a second turn-done", async () => {
    const driver = createClaudeDriver({
      queryFactory: () =>
        (async function* () {
          yield { subtype: "success", total_cost_usd: 0.01, type: "result" };
          throw new Error("cleanup failed");
        })(),
      resolveExecutable: () => Promise.resolve("/bin/claude"),
    });
    const events = await drain(driver.startTurn(baseInput()).events);
    expect(events.filter((e) => e.kind === "turn-done")).toHaveLength(1);
    expect(events.at(-1)?.kind).toBe("error");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/tests/unit/claude-adapter.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

`src/ipc/claude/adapter.ts`:

```ts
import { randomUUID } from "node:crypto";
import type {
  AgentDriver,
  AgentTurnHandle,
  StartTurnInput,
} from "@/ipc/agent/driver";
import type { AgentEvent } from "@/types/agent";
import { mapClaudeMessage } from "./map-events";
import { buildClaudeOptions, type CanUseToolShim } from "./options";
import { resolveClaudeExecutable } from "./executable";

export type ClaudeQueryFactory = (params: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<unknown>;

async function defaultQueryFactory(params: {
  prompt: string;
  options: Record<string, unknown>;
}): Promise<AsyncIterable<unknown>> {
  // The only place the vendor SDK is imported. Lazy so the main bundle does
  // not pay for it until an agent actually runs.
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return sdk.query(params as never);
}

const INSTALL_HINT =
  "Claude Code is not installed (or not on PATH). Install it from https://claude.com/claude-code, or set CLAUDE_BIN to the binary.";

export function createClaudeDriver(dependencies?: {
  queryFactory?: ClaudeQueryFactory;
  resolveExecutable?: () => Promise<string | null>;
}): AgentDriver {
  const resolve =
    dependencies?.resolveExecutable ?? (() => resolveClaudeExecutable());
  const factory: ClaudeQueryFactory | undefined = dependencies?.queryFactory;

  function startTurn(input: StartTurnInput): AgentTurnHandle {
    const controller = new AbortController();
    const turnId = randomUUID();
    let sawResult = false;
    let sessionAnnounced = false;

    const canUseTool: CanUseToolShim = async (toolName, toolInput) => {
      const approved = await input.requestPermission({
        detail: summarize(toolInput),
        requestId: randomUUID(),
        toolName,
      });
      return approved
        ? { behavior: "allow" }
        : { behavior: "deny", message: "Denied from the branchwise panel." };
    };

    async function* events(): AsyncGenerator<AgentEvent> {
      yield { kind: "turn-started", turnId };

      // Nothing in this generator may throw to the consumer: resolver
      // rejections, options building and stream failures all become error
      // events, and a turn emits exactly one terminal turn-done.
      try {
        const executable = await resolve();
        if (!executable) {
          yield { kind: "error", message: INSTALL_HINT };
          yield done("error");
          return;
        }

        const options = buildClaudeOptions({
          abortController: controller,
          canUseTool,
          executable,
          resumeSessionId: input.resume.sessionId,
          tier: input.tier,
          worktreePath: input.worktreePath,
        });

        const stream = factory
          ? factory({ options, prompt: input.prompt })
          : await defaultQueryFactory({ options, prompt: input.prompt });

        for await (const message of stream) {
          if (!sessionAnnounced) {
            const sessionId = (message as { session_id?: unknown }).session_id;
            if (typeof sessionId === "string" && sessionId.length > 0) {
              sessionAnnounced = true;
              input.onSessionId(sessionId);
            }
          }
          for (const event of mapClaudeMessage(message, turnId)) {
            if (event.kind === "turn-done") {
              sawResult = true;
            }
            yield event;
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          yield {
            kind: "error",
            message:
              error instanceof Error ? error.message : "The Claude run failed.",
          };
          // A late failure after the result already closed the turn gets
          // surfaced as noise only — never a second terminal event.
          if (!sawResult) {
            yield done("error");
          }
          return;
        }
      }

      if (!sawResult) {
        yield done(controller.signal.aborted ? "interrupted" : "completed");
      }
    }

    function done(
      stopReason: "completed" | "interrupted" | "error"
    ): AgentEvent {
      sawResult = true;
      return { costUsd: null, kind: "turn-done", stopReason, turnId, usage: null };
    }

    return {
      events: events(),
      interrupt: () => {
        controller.abort();
        return Promise.resolve();
      },
    };
  }

  return {
    id: "claude-code",
    shutdown: () => Promise.resolve(),
    startTurn,
  };
}

function summarize(input: Record<string, unknown>): string {
  for (const key of ["command", "file_path", "path", "url"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      return value.length > 200 ? `${value.slice(0, 200)}…` : value;
    }
  }
  const json = JSON.stringify(input);
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/tests/unit/claude-adapter.test.ts`
Expected: PASS. Note the abort test: SDK child kill on abort is the SDK's
contract; ours is that abort ends the stream and the turn closes as
`interrupted`, which is what the test pins.

- [ ] **Step 5: Commit**

```bash
git add src/ipc/claude/adapter.ts src/tests/unit/claude-adapter.test.ts
git commit -m "Drive Claude turns through the SDK behind the AgentDriver seam"
```

---

### Task 7: Codex executable resolver and app-server JSONL client

**Files:**
- Create: `src/ipc/codex/executable.ts`
- Create: `src/ipc/codex/app-server.ts`
- Test: `src/tests/unit/codex-app-server.test.ts`

**Interfaces:**
- Consumes: nothing vendor-side; `AgentDriverError` (Task 4).
- Produces:
  - `executable.ts`: `resolveCodexExecutable(env?: NodeJS.ProcessEnv): Promise<string | null>` — same shape as Task 3 (`CODEX_BIN` → `~/.local/bin/codex` → `/opt/homebrew/bin/codex` → `/usr/local/bin/codex` → `PATH`).
  - `app-server.ts`: `class CodexAppServer` with `constructor(spawnChild: () => ChildStdio)`, `request(method: string, params: unknown): Promise<unknown>` (auto-connects and runs the `initialize` → `initialized` handshake once), `onNotification(handler: (method: string, params: unknown) => void): () => void`, `onRequest(handler: (method: string, params: unknown) => Promise<unknown> | unknown): () => void` (server→client requests; the handler's resolved value is sent back as the JSON-RPC result), `dispose(): void` (SIGTERM the child, reject all pending). `type ChildStdio = { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream; kill: (signal?: NodeJS.Signals) => void; onExit: (cb: () => void) => void; pid: number | undefined }`. Also export `spawnCodexAppServer(executable: string): ChildStdio` wrapping `child_process.spawn(executable, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"], detached: true })`.

Wire format: one JSON object per line both directions. Client requests carry
auto-increment numeric `id`; responses match by `id`; incoming objects with a
`method` and an `id` are server→client requests (answered via the `onRequest`
handler); with `method` and no `id` they are notifications. A 30 s per-request
deadline rejects and disposes. After `dispose()` or child exit every pending
request rejects.

- [ ] **Step 1: Write the failing test**

`src/tests/unit/codex-app-server.test.ts`:

```ts
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { CodexAppServer, type ChildStdio } from "@/ipc/codex/app-server";

/** An in-memory fake codex child speaking JSONL on the same duplex pair. */
function fakeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const exitCallbacks: (() => void)[] = [];
  const received: Record<string, unknown>[] = [];
  let buffer = "";
  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim().length > 0) {
        const message = JSON.parse(line) as Record<string, unknown>;
        received.push(message);
        // Auto-answer the handshake so tests exercise the rest.
        if (message.method === "initialize") {
          send({ id: message.id, result: {} });
        }
      }
      index = buffer.indexOf("\n");
    }
  });
  function send(message: Record<string, unknown>): void {
    stdout.write(`${JSON.stringify(message)}\n`);
  }
  const child: ChildStdio = {
    kill: () => {
      for (const cb of exitCallbacks) {
        cb();
      }
    },
    onExit: (cb) => exitCallbacks.push(cb),
    pid: 4242,
    stdin,
    stdout,
  };
  return { child, received, send };
}

describe("CodexAppServer", () => {
  test("handshakes once, then routes responses by id", async () => {
    const { child, received, send } = fakeChild();
    const client = new CodexAppServer(() => child);
    const pending = client.request("thread/start", { cwd: "/wt/a" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const threadStart = received.find((m) => m.method === "thread/start");
    expect(threadStart).toBeDefined();
    expect(received[0]?.method).toBe("initialize");
    expect(received.some((m) => m.method === "initialized")).toBe(true);
    send({ id: threadStart?.id, result: { threadId: "th_1" } });
    await expect(pending).resolves.toEqual({ threadId: "th_1" });
  });

  test("split JSONL frames reassemble across chunk boundaries", async () => {
    const { child, send } = fakeChild();
    const client = new CodexAppServer(() => child);
    const notifications: [string, unknown][] = [];
    client.onNotification((method, params) => notifications.push([method, params]));
    // Fire-and-forget just to trigger connection — this request is never
    // answered by the fake and must not be awaited (30s timeout).
    void client.request("thread/start", {}).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Write one notification in two raw chunks.
    const line = `${JSON.stringify({
      method: "item/agentMessage/delta",
      params: { delta: "hi" },
    })}\n`;
    (child.stdout as PassThrough).write(line.slice(0, 12));
    (child.stdout as PassThrough).write(line.slice(12));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(notifications).toContainEqual([
      "item/agentMessage/delta",
      { delta: "hi" },
    ]);
    client.dispose(); // clears the unanswered request's 30s timer
  });

  test("server-to-client requests are answered through the handler", async () => {
    const { child, received, send } = fakeChild();
    const client = new CodexAppServer(() => child);
    client.onRequest((method) =>
      method === "item/commandExecution/requestApproval"
        ? { decision: "accept" }
        : { decision: "decline" }
    );
    // Trigger connection.
    const pending = client.request("thread/start", {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    send({
      id: 999,
      method: "item/commandExecution/requestApproval",
      params: { command: "ls", itemId: "i1", threadId: "t", turnId: "u" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reply = received.find((m) => m.id === 999 && "result" in m);
    expect(reply?.result).toEqual({ decision: "accept" });
    const start = received.find((m) => m.method === "thread/start");
    send({ id: start?.id, result: {} });
    await pending;
  });

  test("dispose rejects everything pending", async () => {
    const { child } = fakeChild();
    const client = new CodexAppServer(() => child);
    const pending = client.request("thread/start", {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    client.dispose();
    await expect(pending).rejects.toThrow();
  });

  test("a child crash resets state so the next request reconnects cleanly", async () => {
    let spawned = 0;
    const children: ReturnType<typeof fakeChild>[] = [];
    const client = new CodexAppServer(() => {
      spawned += 1;
      const fake = fakeChild();
      children.push(fake);
      return fake.child;
    });
    const first = client.request("thread/start", {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Die mid-line: the torn fragment must not prefix generation two.
    (children[0]?.child.stdout as PassThrough).write('{"partial');
    children[0]?.child.kill();
    await expect(first).rejects.toThrow();

    const second = client.request("thread/start", {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(spawned).toBe(2);
    const start = children[1]?.received.find(
      (m) => m.method === "thread/start"
    );
    expect(start).toBeDefined();
    children[1]?.send({ id: start?.id, result: { threadId: "th_2" } });
    await expect(second).resolves.toEqual({ threadId: "th_2" });

    // A stale exit from the dead generation must not touch the live one:
    // re-firing generation one's exit callbacks and then making a third
    // request must neither respawn nor break generation two.
    children[0]?.child.kill();
    const third = client.request("thread/status", {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(spawned).toBe(2);
    const status = children[1]?.received.find(
      (m) => m.method === "thread/status"
    );
    expect(status).toBeDefined();
    children[1]?.send({ id: status?.id, result: { ok: true } });
    await expect(third).resolves.toEqual({ ok: true });
  });

  test("a synchronously throwing request handler becomes an error reply", async () => {
    const { child, received, send } = fakeChild();
    const client = new CodexAppServer(() => child);
    client.onRequest(() => {
      throw new Error("handler blew up");
    });
    const pending = client.request("thread/start", {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    send({ id: 55, method: "item/commandExecution/requestApproval", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reply = received.find((m) => m.id === 55 && "error" in m);
    expect(reply).toBeDefined();
    const start = received.find((m) => m.method === "thread/start");
    send({ id: start?.id, result: {} });
    await pending;
  });

  test("a handler returning undefined passes the request to the next one", async () => {
    const { child, received, send } = fakeChild();
    const client = new CodexAppServer(() => child);
    client.onRequest(() => undefined);
    client.onRequest(() => ({ decision: "accept" }));
    const pending = client.request("thread/start", {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    send({ id: 77, method: "item/fileChange/requestApproval", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reply = received.find((m) => m.id === 77 && "result" in m);
    expect(reply?.result).toEqual({ decision: "accept" });
    const start = received.find((m) => m.method === "thread/start");
    send({ id: start?.id, result: {} });
    await pending;
  });

  test("requests dispatch only after same-chunk responses have settled", async () => {
    const { child, received } = fakeChild();
    const client = new CodexAppServer(() => child);
    let settled = false;
    const pending = client.request("thread/start", {}).then((result) => {
      settled = true;
      return result;
    });
    const seenSettled: boolean[] = [];
    client.onRequest(() => {
      seenSettled.push(settled);
      return { decision: "decline" };
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const start = received.find((m) => m.method === "thread/start");
    // One chunk: our response immediately followed by a server request.
    (child.stdout as PassThrough).write(
      `${JSON.stringify({ id: start?.id, result: { threadId: "th_1" } })}\n${JSON.stringify(
        { id: 88, method: "item/permissions/requestApproval", params: {} }
      )}\n`
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await pending;
    expect(seenSettled).toEqual([true]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/tests/unit/codex-app-server.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

`src/ipc/codex/executable.ts` (thin wrapper over Task 3's shared
`findExecutable` — do not duplicate the search loop; same injectable
`systemCandidates` parameter as the Claude wrapper so tests stay hermetic):

```ts
import path from "node:path";
import { findExecutable } from "@/ipc/agent/find-executable";

const DEFAULT_SYSTEM_CANDIDATES = [
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
];

export function resolveCodexExecutable(
  env: NodeJS.ProcessEnv = process.env,
  systemCandidates: string[] = DEFAULT_SYSTEM_CANDIDATES
): Promise<string | null> {
  const home = env.HOME ?? "";
  return findExecutable({
    binaryName: "codex",
    env,
    envOverride: env.CODEX_BIN,
    extraCandidates: [
      ...(home ? [path.join(home, ".local", "bin", "codex")] : []),
      ...systemCandidates,
    ],
  });
}
```

`src/ipc/codex/app-server.ts`:

```ts
import { spawn } from "node:child_process";
import { AgentDriverError } from "@/ipc/agent/driver";

export interface ChildStdio {
  kill: (signal?: NodeJS.Signals) => void;
  onExit: (cb: () => void) => void;
  pid: number | undefined;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
}

export function spawnCodexAppServer(executable: string): ChildStdio {
  // Its own process group so quit-time cleanup can kill the whole tree.
  const child = spawn(executable, ["app-server", "--stdio"], {
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    kill: (signal) => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal ?? "SIGTERM");
        } catch {
          child.kill(signal ?? "SIGTERM");
        }
      }
    },
    onExit: (cb) => child.once("exit", cb),
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout,
  };
}

const REQUEST_TIMEOUT_MS = 30_000;

interface Pending {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timer: NodeJS.Timeout;
}

/**
 * Minimal JSONL JSON-RPC client for `codex app-server --stdio` (canvas-proven
 * transport, reimplemented against branchwise's needs). One instance owns one
 * child; the codex adapter holds one instance per app run.
 */
export class CodexAppServer {
  private readonly spawnChild: () => ChildStdio;
  private child: ChildStdio | null = null;
  private handshake: Promise<void> | null = null;
  private nextId = 1;
  private buffer = "";
  private disposed = false;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers = new Set<
    (method: string, params: unknown) => void
  >();
  private readonly requestHandlers = new Set<
    (method: string, params: unknown) => Promise<unknown> | unknown
  >();
  private readonly exitHandlers = new Set<() => void>();

  constructor(spawnChild: () => ChildStdio) {
    this.spawnChild = spawnChild;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onRequest(
    handler: (method: string, params: unknown) => Promise<unknown> | unknown
  ): () => void {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  /**
   * Fires when the live child exits, after pending requests were rejected.
   * Turns awaiting notifications (not requests) need this to learn the
   * process died — otherwise a mid-turn crash suspends them forever.
   */
  onChildExit(handler: () => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    await this.connect();
    return this.rawRequest(method, params);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new AgentDriverError("codex app-server was shut down."));
    }
    this.pending.clear();
    this.child?.kill("SIGTERM");
    this.child = null;
  }

  private connect(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(
        new AgentDriverError("codex app-server was shut down.")
      );
    }
    if (this.handshake) {
      return this.handshake;
    }

    const child = this.spawnChild();
    this.child = child;
    // Fresh generation, fresh framing state: a torn line from a dead child
    // must never prefix the next child's first response.
    this.buffer = "";
    const onData = (chunk: Buffer) => {
      if (this.child === child) {
        this.receive(chunk);
      }
    };
    child.stdout.on("data", onData);
    child.onExit(() => {
      child.stdout.removeListener("data", onData);
      if (this.child !== child) {
        // A superseded generation's delayed exit must not tear down the
        // live generation's state — only its own listener above.
        return;
      }
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new AgentDriverError("codex app-server exited."));
      }
      this.pending.clear();
      this.handshake = null;
      this.child = null;
      this.buffer = "";
      for (const handler of this.exitHandlers) {
        handler();
      }
    });

    this.handshake = (async () => {
      try {
        await this.rawRequest("initialize", {
          capabilities: {},
          clientInfo: {
            name: "branchwise",
            title: "branchwise",
            version: "0.0.1",
          },
        });
        this.send({ method: "initialized" });
      } catch (error) {
        // A failed handshake must not wedge the instance or leak the child:
        // reset so the next request retries against a fresh process.
        if (this.child === child) {
          this.child = null;
          child.kill("SIGTERM");
        }
        this.handshake = null;
        this.buffer = "";
        throw error;
      }
    })();
    return this.handshake;
  }

  private rawRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AgentDriverError(`codex did not answer ${method} within 30s.`)
        );
      }, REQUEST_TIMEOUT_MS);
      // Register BEFORE sending: a same-tick responder (the in-memory test
      // fake — PassThrough delivers synchronously) would otherwise answer
      // before the entry exists and the response would be dropped.
      this.pending.set(id, { reject, resolve, timer });
      this.send({ id, method, params });
    });
  }

  private send(message: Record<string, unknown>): void {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim().length > 0) {
        this.route(line);
      }
      index = this.buffer.indexOf("\n");
    }
  }

  private route(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof message.method === "string") {
      if (message.id === undefined) {
        for (const handler of this.notificationHandlers) {
          handler(message.method, message.params);
        }
        return;
      }
      // Server→client request. Deferred one microtask so responses in the
      // same stdout chunk settle first (a thread/start reply and that
      // thread's first approval can share a chunk — the awaiter must see
      // its threadId before the approval dispatches). Handlers are tried in
      // registration order; the first to answer non-undefined claims the
      // request (concurrent turns each pass on requests that aren't
      // theirs). A synchronous throw becomes an error reply. Unclaimed
      // requests get an error reply rather than an invented decision.
      queueMicrotask(() => {
        void this.dispatchRequest(message);
      });
      return;
    }

    const id = typeof message.id === "number" ? message.id : null;
    if (id === null) {
      return;
    }
    const entry = this.pending.get(id);
    if (!entry) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if ("error" in message) {
      const error = message.error as { message?: string } | undefined;
      entry.reject(
        new AgentDriverError(error?.message ?? "codex request failed")
      );
      return;
    }
    entry.resolve(message.result);
  }

  private async dispatchRequest(message: Record<string, unknown>): Promise<void> {
    const id = message.id as number;
    const method = message.method as string;
    try {
      for (const handler of [...this.requestHandlers]) {
        // Sequential on purpose: registration order is the claim order.
        // biome-ignore lint/performance/noAwaitInLoops: see above
        const result = await handler(method, message.params);
        if (result !== undefined) {
          this.send({ id, result });
          return;
        }
      }
      this.send({
        error: { code: -32_001, message: `no handler claimed ${method}` },
        id,
      });
    } catch (error) {
      this.send({
        error: {
          code: -32_000,
          message: error instanceof Error ? error.message : "failed",
        },
        id,
      });
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/tests/unit/codex-app-server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ipc/codex/executable.ts src/ipc/codex/app-server.ts src/tests/unit/codex-app-server.test.ts
git commit -m "Speak JSONL JSON-RPC to the user's codex app-server"
```

---

### Task 8: Codex event mapper and adapter

**Files:**
- Create: `src/ipc/codex/map-events.ts`
- Create: `src/ipc/codex/adapter.ts`
- Test: `src/tests/unit/codex-map-events.test.ts`
- Test: `src/tests/unit/codex-adapter.test.ts`

**Interfaces:**
- Consumes: `CodexAppServer`, `ChildStdio`, `spawnCodexAppServer` (Task 7); `resolveCodexExecutable` (Task 7); driver types (Task 4); `AgentEvent` (Task 1).
- Produces:
  - `map-events.ts`: `mapCodexNotification(method: string, params: unknown, context: { threadId: string; turnId: string }): AgentEvent[]` — `item/agentMessage/delta {delta}` → text-delta; `item/reasoning/textDelta` and `item/reasoning/summaryTextDelta` → thinking-delta; `item/started {item}` → tool-started (item types: `commandExecution` → name "shell" + `command` detail; `fileChange` → name "file_change" + path detail; `mcpToolCall`/`dynamicToolCall` → item.tool; `webSearch` → "web_search"); `item/completed {item}` → tool-finished (`status === "failed"` → ok:false); `turn/completed {turn}` → turn-done (status "failed" → error + stopReason "error"; usage from `turn.usage.inputTokens/outputTokens` when present); `error {message}` → error. Notifications whose `params.threadId` differs from `context.threadId` → `[]` (cross-thread leakage guard). Unknown methods → `[]`.
  - `adapter.ts`: `createCodexDriver(dependencies?: { client?: CodexAppServer; resolveExecutable?: () => Promise<string | null> }): AgentDriver`. Tier → thread config exactly per Global Constraints. Approval requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, legacy `applyPatchApproval`, `execCommandApproval`) route to `input.requestPermission` (detail = `params.command` or file summary; requestId = `String(params.itemId ?? params.approvalId ?? params.call_id ?? randomUUID())`) and answer `{ decision: approved ? "accept" : "decline" }`. `thread/start` on first turn per worktree (or `thread/resume {threadId}` when `input.resume.threadId` is set, falling back to `thread/start` on error); `onThreadId` fired when the id is known; `turn/start { threadId, cwd, input: [{ type: "text", text: prompt }] }`; interrupt → `turn/interrupt { threadId, turnId }`; `shutdown()` disposes the client.

- [ ] **Step 1: Write the failing mapper test**

`src/tests/unit/codex-map-events.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { mapCodexNotification } from "@/ipc/codex/map-events";

const CTX = { threadId: "th_1", turnId: "turn_1" };

describe("mapCodexNotification", () => {
  test("agent message delta", () => {
    expect(
      mapCodexNotification(
        "item/agentMessage/delta",
        { delta: "hey", threadId: "th_1" },
        CTX
      )
    ).toEqual([{ kind: "text-delta", text: "hey" }]);
  });

  test("reasoning deltas map to thinking", () => {
    expect(
      mapCodexNotification(
        "item/reasoning/textDelta",
        { delta: "let me see", threadId: "th_1" },
        CTX
      )
    ).toEqual([{ kind: "thinking-delta", text: "let me see" }]);
  });

  test("command execution item lifecycle", () => {
    expect(
      mapCodexNotification(
        "item/started",
        {
          item: { command: "npm test", id: "it_1", type: "commandExecution" },
          threadId: "th_1",
        },
        CTX
      )
    ).toEqual([
      { detail: "npm test", kind: "tool-started", name: "shell", toolId: "it_1" },
    ]);
    expect(
      mapCodexNotification(
        "item/completed",
        {
          item: { id: "it_1", status: "failed", type: "commandExecution" },
          threadId: "th_1",
        },
        CTX
      )
    ).toEqual([{ detail: "", kind: "tool-finished", ok: false, toolId: "it_1" }]);
  });

  test("turn completion carries usage; failed status is an error", () => {
    expect(
      mapCodexNotification(
        "turn/completed",
        {
          threadId: "th_1",
          turn: {
            status: "completed",
            usage: { inputTokens: 900, outputTokens: 120 },
          },
        },
        CTX
      )
    ).toEqual([
      {
        costUsd: null,
        kind: "turn-done",
        stopReason: "completed",
        turnId: "turn_1",
        usage: { inputTokens: 900, outputTokens: 120 },
      },
    ]);
    const failed = mapCodexNotification(
      "turn/completed",
      { threadId: "th_1", turn: { status: "failed" } },
      CTX
    );
    expect(failed.at(-1)).toMatchObject({ stopReason: "error" });
  });

  test("cross-thread notifications are dropped", () => {
    expect(
      mapCodexNotification(
        "item/agentMessage/delta",
        { delta: "leak", threadId: "th_OTHER" },
        CTX
      )
    ).toEqual([]);
  });

  test("unknown methods map to nothing", () => {
    expect(mapCodexNotification("thread/metadata", {}, CTX)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/tests/unit/codex-map-events.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the mapper**

`src/ipc/codex/map-events.ts`:

```ts
import type { AgentEvent } from "@/types/agent";

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return value !== null && typeof value === "object" ? (value as Rec) : null;
}

/** Exported: the adapter clips approval-request details through this too. */
export function clip(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  // One-line contract for detail fields: collapse newlines before capping.
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

function itemName(item: Rec): string {
  switch (item.type) {
    case "commandExecution":
      return "shell";
    case "fileChange":
      return "file_change";
    case "webSearch":
      return "web_search";
    case "mcpToolCall":
    case "dynamicToolCall":
      return typeof item.tool === "string" ? item.tool : "tool";
    default:
      return typeof item.type === "string" ? item.type : "tool";
  }
}

function itemDetail(item: Rec): string {
  return clip(item.command) || clip(item.path) || clip(item.query) || "";
}

/**
 * Normalises one codex app-server notification into branchwise events.
 * Anything addressed to a different thread is dropped here — the one place
 * cross-thread leakage is possible.
 */
export function mapCodexNotification(
  method: string,
  params: unknown,
  context: { threadId: string; turnId: string }
): AgentEvent[] {
  const p = rec(params);
  if (!p) {
    return [];
  }
  if (typeof p.threadId === "string" && p.threadId !== context.threadId) {
    return [];
  }

  switch (method) {
    case "item/agentMessage/delta":
      return typeof p.delta === "string"
        ? [{ kind: "text-delta", text: p.delta }]
        : [];

    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta":
      return typeof p.delta === "string"
        ? [{ kind: "thinking-delta", text: p.delta }]
        : [];

    case "item/started": {
      const item = rec(p.item);
      if (!item || item.type === "agentMessage" || item.type === "reasoning") {
        return [];
      }
      return typeof item.id === "string"
        ? [
            {
              detail: itemDetail(item),
              kind: "tool-started",
              name: itemName(item),
              toolId: item.id,
            },
          ]
        : [];
    }

    case "item/completed": {
      const item = rec(p.item);
      if (!item || item.type === "agentMessage" || item.type === "reasoning") {
        return [];
      }
      return typeof item.id === "string"
        ? [
            {
              detail: clip(item.error) || "",
              kind: "tool-finished",
              ok: item.status !== "failed",
              toolId: item.id,
            },
          ]
        : [];
    }

    case "turn/completed": {
      const turn = rec(p.turn);
      const usage = rec(turn?.usage);
      const failed = turn?.status === "failed";
      const events: AgentEvent[] = [];
      if (failed) {
        events.push({ kind: "error", message: "The codex turn failed." });
      }
      events.push({
        costUsd: null,
        kind: "turn-done",
        stopReason: failed ? "error" : "completed",
        turnId: context.turnId,
        usage: usage
          ? {
              inputTokens:
                typeof usage.inputTokens === "number" ? usage.inputTokens : null,
              outputTokens:
                typeof usage.outputTokens === "number"
                  ? usage.outputTokens
                  : null,
            }
          : null,
      });
      return events;
    }

    case "error":
      return [
        {
          kind: "error",
          message: clip(p.message) || "codex reported an error.",
        },
      ];

    default:
      return [];
  }
}
```

- [ ] **Step 4: Run the mapper test to verify it passes**

Run: `npx vitest run src/tests/unit/codex-map-events.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing adapter test**

`src/tests/unit/codex-adapter.test.ts` — reuse the `fakeChild` helper by
importing the client directly; the fake now scripts a whole turn:

```ts
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { CodexAppServer, type ChildStdio } from "@/ipc/codex/app-server";
import { createCodexDriver } from "@/ipc/codex/adapter";
import type { StartTurnInput } from "@/ipc/agent/driver";
import type { AgentEvent } from "@/types/agent";

function scriptedChild(options: {
  withApproval: boolean;
  delayTurnAck?: boolean;
  killAfterTurnStart?: boolean;
}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const received: Record<string, unknown>[] = [];
  const exitCallbacks: (() => void)[] = [];
  let releaseAck: (() => void) | null = null;
  let buffer = "";
  function send(message: Record<string, unknown>): void {
    stdout.write(`${JSON.stringify(message)}\n`);
  }
  function finishTurn(): void {
    send({
      method: "item/agentMessage/delta",
      params: { delta: "done", threadId: "th_9" },
    });
    send({
      method: "turn/completed",
      params: { threadId: "th_9", turn: { status: "completed" } },
    });
  }
  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (line.trim().length === 0) {
        continue;
      }
      const message = JSON.parse(line) as Record<string, unknown>;
      received.push(message);
      if (message.method === "initialize") {
        send({ id: message.id, result: {} });
      }
      if (message.method === "thread/start") {
        send({ id: message.id, result: { threadId: "th_9" } });
      }
      if (message.method === "turn/start") {
        const ack = () => send({ id: message.id, result: { turnId: "turn_9" } });
        if (options.delayTurnAck) {
          releaseAck = ack;
          continue;
        }
        ack();
        if (options.killAfterTurnStart) {
          // Die without ever completing the turn.
          for (const cb of exitCallbacks) {
            cb();
          }
          continue;
        }
        if (options.withApproval) {
          // Ask for approval before doing anything else; the wire round-trip
          // is what's under test, not the decision's effect.
          send({
            id: 77,
            method: "item/commandExecution/requestApproval",
            params: {
              command: "rm -rf build",
              itemId: "call_1",
              threadId: "th_9",
              turnId: "turn_9",
            },
          });
        }
        finishTurn();
      }
      if (message.method === "turn/interrupt") {
        send({ id: message.id, result: {} });
        finishTurn();
      }
    }
  });
  const child: ChildStdio = {
    kill: () => {
      for (const cb of exitCallbacks) {
        cb();
      }
    },
    onExit: (cb) => exitCallbacks.push(cb),
    pid: 1,
    stdin,
    stdout,
  };
  return {
    child,
    received,
    releaseTurnAck: () => releaseAck?.(),
    send,
  };
}

function baseInput(overrides: Partial<StartTurnInput> = {}): StartTurnInput {
  return {
    onSessionId: () => {},
    onThreadId: () => {},
    prompt: "go",
    requestPermission: () => Promise.resolve(true),
    resume: { sessionId: null, threadId: null },
    tier: "accept-edits",
    worktreePath: "/wt/feat-a",
    ...overrides,
  };
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) {
    out.push(event);
  }
  return out;
}

describe("codex adapter", () => {
  test("starts a thread with the worktree cwd and tier-mapped sandbox", async () => {
    const { child, received } = scriptedChild({ withApproval: false });
    const driver = createCodexDriver({
      client: new CodexAppServer(() => child),
    });
    const threadIds: string[] = [];
    const events = await drain(
      driver.startTurn(baseInput({ onThreadId: (id) => threadIds.push(id) }))
        .events
    );
    const start = received.find((m) => m.method === "thread/start");
    expect(start?.params).toMatchObject({
      approvalPolicy: "on-request",
      cwd: "/wt/feat-a",
      sandbox: "workspace-write",
    });
    const turn = received.find((m) => m.method === "turn/start");
    expect(turn?.params).toMatchObject({
      cwd: "/wt/feat-a",
      input: [{ text: "go", type: "text" }],
      threadId: "th_9",
    });
    expect(threadIds).toEqual(["th_9"]);
    expect(events.some((e) => e.kind === "permission-request")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      kind: "turn-done",
      stopReason: "completed",
    });
  });

  test("approval request routes through requestPermission and answers accept/decline", async () => {
    const { child, received } = scriptedChild({ withApproval: true });
    const driver = createCodexDriver({
      client: new CodexAppServer(() => child),
    });
    const asked: string[] = [];
    const events = await drain(
      driver.startTurn(
        baseInput({
          requestPermission: (request) => {
            asked.push(request.detail);
            return Promise.resolve(false);
          },
        })
      ).events
    );
    expect(asked).toEqual(["rm -rf build"]);
    const reply = received.find((m) => m.id === 77 && "result" in m);
    expect(reply?.result).toEqual({ decision: "decline" });
    // The manager owns permission events; the adapter stream must not
    // duplicate them.
    expect(
      events.some(
        (e) =>
          e.kind === "permission-request" || e.kind === "permission-resolved"
      )
    ).toBe(false);
  });

  test("yolo tier maps to danger-full-access + never", async () => {
    const { child, received } = scriptedChild({ withApproval: false });
    const driver = createCodexDriver({
      client: new CodexAppServer(() => child),
    });
    await drain(driver.startTurn(baseInput({ tier: "yolo" })).events);
    const start = received.find((m) => m.method === "thread/start");
    expect(start?.params).toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });

  test("missing executable is an error event when no client injected", async () => {
    const driver = createCodexDriver({
      resolveExecutable: () => Promise.resolve(null),
    });
    const events = await drain(driver.startTurn(baseInput()).events);
    expect(events.some((e) => e.kind === "error")).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "turn-done", stopReason: "error" });
  });

  test("a codex crash mid-turn closes the turn instead of hanging", async () => {
    const { child } = scriptedChild({
      killAfterTurnStart: true,
      withApproval: false,
    });
    const driver = createCodexDriver({
      client: new CodexAppServer(() => child),
    });
    const events = await drain(driver.startTurn(baseInput()).events);
    expect(events.some((e) => e.kind === "error")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      kind: "turn-done",
      stopReason: "error",
    });
  });

  test("an interrupt before the turn ack is delivered after it", async () => {
    const { child, received, releaseTurnAck } = scriptedChild({
      delayTurnAck: true,
      withApproval: false,
    });
    const driver = createCodexDriver({
      client: new CodexAppServer(() => child),
    });
    const handle = driver.startTurn(baseInput());
    const drained = drain(handle.events);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await handle.interrupt(); // the ack has not returned yet — must not be lost
    releaseTurnAck();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const interruptMessage = received.find(
      (m) => m.method === "turn/interrupt"
    );
    expect(interruptMessage?.params).toMatchObject({
      threadId: "th_9",
      turnId: "turn_9",
    });
    await drained;
  });
});
```

- [ ] **Step 6: Run it to verify it fails, implement the adapter**

Run: `npx vitest run src/tests/unit/codex-adapter.test.ts` — FAIL (module missing).

`src/ipc/codex/adapter.ts`:

```ts
import { randomUUID } from "node:crypto";
import type {
  AgentDriver,
  AgentTurnHandle,
  StartTurnInput,
} from "@/ipc/agent/driver";
import type { AgentEvent, PermissionTier } from "@/types/agent";
import { CodexAppServer, spawnCodexAppServer } from "./app-server";
import { resolveCodexExecutable } from "./executable";
import { clip, mapCodexNotification } from "./map-events";

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "applyPatchApproval",
  "execCommandApproval",
]);

const TIER_TO_THREAD: Record<
  PermissionTier,
  { approvalPolicy: string; sandbox: string }
> = {
  "accept-edits": { approvalPolicy: "on-request", sandbox: "workspace-write" },
  ask: { approvalPolicy: "untrusted", sandbox: "workspace-write" },
  plan: { approvalPolicy: "on-request", sandbox: "read-only" },
  yolo: { approvalPolicy: "never", sandbox: "danger-full-access" },
};

const INSTALL_HINT =
  "codex is not installed (or not on PATH). Install it with `npm i -g @openai/codex` or set CODEX_BIN.";

function rec(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function createCodexDriver(dependencies?: {
  client?: CodexAppServer;
  /** Called with each spawned child's pid so the manager can pidfile it. */
  onSpawn?: (pid: number) => void;
  resolveExecutable?: () => Promise<string | null>;
}): AgentDriver {
  let client: CodexAppServer | null = dependencies?.client ?? null;
  const resolve =
    dependencies?.resolveExecutable ?? (() => resolveCodexExecutable());
  /** threadId per worktree, for this app run. The registry outlives us. */
  const threads = new Map<string, string>();

  async function ensureClient(): Promise<CodexAppServer> {
    if (client) {
      return client;
    }
    const executable = await resolve();
    if (!executable) {
      throw new Error(INSTALL_HINT);
    }
    client = new CodexAppServer(() => {
      const child = spawnCodexAppServer(executable);
      if (child.pid !== undefined) {
        dependencies?.onSpawn?.(child.pid);
      }
      return child;
    });
    return client;
  }

  function startTurn(input: StartTurnInput): AgentTurnHandle {
    const turnId = randomUUID();
    let liveThreadId: string | null = null;
    let liveTurnId: string | null = null;
    let interrupted = false;

    async function* events(): AsyncGenerator<AgentEvent> {
      yield { kind: "turn-started", turnId };

      let server: CodexAppServer;
      try {
        server = await ensureClient();
      } catch (error) {
        yield {
          kind: "error",
          message: error instanceof Error ? error.message : INSTALL_HINT,
        };
        yield {
          costUsd: null,
          kind: "turn-done",
          stopReason: "error",
          turnId,
          usage: null,
        };
        return;
      }

      // Buffered relay: notifications and approvals arrive on callbacks and
      // are re-yielded here in arrival order.
      const queue: AgentEvent[] = [];
      let wake: (() => void) | null = null;
      let finished = false;
      function push(event: AgentEvent): void {
        queue.push(event);
        if (event.kind === "turn-done") {
          finished = true;
        }
        wake?.();
        wake = null;
      }

      const offRequest = server.onRequest(async (method, params) => {
        if (!APPROVAL_METHODS.has(method)) {
          return; // not ours — let another handler claim it
        }
        const p = rec(params) ?? {};
        if (typeof p.threadId === "string" && p.threadId !== liveThreadId) {
          return; // another turn's thread — its handler claims it
        }
        const requestId = String(p.itemId ?? p.approvalId ?? p.call_id ?? randomUUID());
        const detail =
          clip(p.command) || clip(p.path) || clip(p.reason) || method;
        // The manager emits the permission-request / permission-resolved
        // events for every vendor — pushing them here too would render each
        // approval card twice.
        const approved = await input.requestPermission({
          detail,
          requestId,
          toolName: method,
        });
        return { decision: approved ? "accept" : "decline" };
      });

      const offExit = server.onChildExit(() => {
        // The process died mid-turn: close the turn or the consumer waits
        // forever on a wake that never comes.
        push({ kind: "error", message: "codex exited mid-turn." });
        push({
          costUsd: null,
          kind: "turn-done",
          stopReason: "error",
          turnId,
          usage: null,
        });
      });

      const offNotification = server.onNotification((method, params) => {
        if (!liveThreadId) {
          return;
        }
        const mapped = mapCodexNotification(method, params, {
          threadId: liveThreadId,
          turnId,
        });
        for (const event of mapped) {
          push(event);
        }
      });

      try {
        const known = input.resume.threadId ?? threads.get(input.worktreePath);
        const tierConfig = TIER_TO_THREAD[input.tier];
        if (known) {
          try {
            await server.request("thread/resume", { threadId: known });
            liveThreadId = known;
          } catch {
            liveThreadId = null;
          }
        }
        if (!liveThreadId) {
          const started = rec(
            await server.request("thread/start", {
              approvalPolicy: tierConfig.approvalPolicy,
              cwd: input.worktreePath,
              sandbox: tierConfig.sandbox,
            })
          );
          const threadId = started?.threadId;
          if (typeof threadId !== "string") {
            throw new Error("codex did not return a thread id.");
          }
          liveThreadId = threadId;
        }
        threads.set(input.worktreePath, liveThreadId);
        input.onThreadId(liveThreadId);

        const turnStarted = rec(
          await server.request("turn/start", {
            cwd: input.worktreePath,
            input: [{ text: input.prompt, type: "text" }],
            threadId: liveThreadId,
          })
        );
        liveTurnId =
          typeof turnStarted?.turnId === "string" ? turnStarted.turnId : null;
        if (interrupted && liveThreadId && liveTurnId) {
          // Interrupt arrived while the ack was in flight: deliver it now
          // instead of silently dropping it.
          void server
            .request("turn/interrupt", {
              threadId: liveThreadId,
              turnId: liveTurnId,
            })
            .catch(() => {});
        }

        while (!finished) {
          const next = queue.shift();
          if (next) {
            yield next;
            continue;
          }
          await new Promise<void>((resolveWake) => {
            wake = resolveWake;
          });
        }
        while (queue.length > 0) {
          const next = queue.shift();
          if (next) {
            yield next;
          }
        }
      } catch (error) {
        yield {
          kind: "error",
          message:
            error instanceof Error ? error.message : "The codex run failed.",
        };
        yield {
          costUsd: null,
          kind: "turn-done",
          stopReason: interrupted ? "interrupted" : "error",
          turnId,
          usage: null,
        };
      } finally {
        offNotification();
        offRequest();
        offExit();
      }
    }

    return {
      events: events(),
      interrupt: async () => {
        interrupted = true;
        if (liveThreadId && liveTurnId && client) {
          await client
            .request("turn/interrupt", {
              threadId: liveThreadId,
              turnId: liveTurnId,
            })
            .catch(() => {});
        }
      },
    };
  }

  return {
    id: "codex",
    shutdown: () => {
      client?.dispose();
      client = null;
      return Promise.resolve();
    },
    startTurn,
  };
}
```

- [ ] **Step 7: Run both test files to verify they pass**

Run: `npx vitest run src/tests/unit/codex-map-events.test.ts src/tests/unit/codex-adapter.test.ts`
Expected: PASS. If `turn/completed` arrives before `turn/start`'s ack in the
fake (it can — the fake replies inline), the buffered-relay design absorbs it;
that ordering is part of what these tests pin.

- [ ] **Step 8: Commit**

```bash
git add src/ipc/codex/map-events.ts src/ipc/codex/adapter.ts src/tests/unit/codex-map-events.test.ts src/tests/unit/codex-adapter.test.ts
git commit -m "Drive codex turns over app-server with UI-routed approvals"
```

---

### Task 9: The session manager, pid registry, and quit teardown

**Files:**
- Create: `src/ipc/agent/manager.ts`
- Create: `src/ipc/agent/pids.ts`
- Modify: `src/main.ts:105-111` (quit hook)
- Test: `src/tests/unit/agent-manager.test.ts`
- Test: `src/tests/unit/agent-pids.test.ts`

**Interfaces:**
- Consumes: everything above — drivers via a driver registry `{ "claude-code": createClaudeDriver(), codex: createCodexDriver() }` (constructed lazily in the manager), `EventQueue` from `@/lib/queue`, transcript + registry (Task 2), `foldEvent` not needed here (renderer-side).
- Produces (module `manager.ts`, module-level state like the terminal manager):
  - `configureManager(options: { baseDir: string; drivers?: Partial<Record<AgentDriverId, AgentDriver>> }): void` — test seam; default baseDir is `path.join(app.getPath("userData"), "agent")` resolved lazily inside the module's `baseDir()` helper, which imports electron dynamically so tests never touch electron.
  - `getConfig(worktreePath): Promise<{ config: AgentConfig; hasConversation: boolean; turnActive: boolean }>`
  - `setConfig(worktreePath, config: AgentConfig): Promise<void>`
  - `send(worktreePath, text): Promise<{ accepted: boolean; reason?: string }>` — rejects when a turn is active; emits `user-message`; starts the driver turn; pumps events through the delta accumulator into broadcast + transcript; persists sessionId/threadId via callbacks; parks permissions.
  - `attachAgent(worktreePath): { queue: EventQueue<AgentEvent>; replay: AgentEvent[] }` and `detachAgent(worktreePath, queue)`.
  - `interruptTurn(worktreePath): Promise<void>`
  - `respondPermission(worktreePath, requestId: string, approved: boolean): boolean`
  - `readHistory(worktreePath): Promise<AgentEvent[]>` — transcript passthrough; never spawns.
  - `shutdownAgents(timeoutMs?: number): Promise<void>` — interrupt all turns, driver shutdowns, then SIGKILL any pid still alive in the pidfile; clears the pidfile.
- Produces (module `pids.ts`):
  - `registerPid(baseDir, pid: number): Promise<void>`, `unregisterPid(baseDir, pid): Promise<void>`, `listPids(baseDir): Promise<number[]>`, `reapStrays(baseDir): Promise<number[]>` — kill(pid, 0) probe, SIGKILL live ones, return what was killed, rewrite the file empty.

Delta accumulator contract (tested): consecutive `text-delta`s buffer and
flush as one merged event on a 50 ms timer **or** immediately when any
non-delta event arrives (order preserved); same for `thinking-delta`. Every
flushed event is appended to the transcript and broadcast to subscribers.
`turn-done` additionally updates the registry timestamp and clears the active
turn. The replay array is the active turn's already-flushed events (committed
history comes from `readHistory`).

- [ ] **Step 1: Write the failing tests**

`src/tests/unit/agent-pids.test.ts`:

```ts
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { listPids, reapStrays, registerPid, unregisterPid } from "@/ipc/agent/pids";

let base = "";
beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "bw-pids-"));
});
afterEach(async () => {
  await rm(base, { force: true, recursive: true });
});

describe("pid registry", () => {
  test("register, list, unregister round-trip", async () => {
    await registerPid(base, 1111);
    await registerPid(base, 2222);
    expect(await listPids(base)).toEqual([1111, 2222]);
    await unregisterPid(base, 1111);
    expect(await listPids(base)).toEqual([2222]);
  });

  test("reap kills a live stray and clears the file", async () => {
    const child = spawn("sleep", ["30"]);
    const pid = child.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) {
      return;
    }
    await registerPid(base, pid);
    await registerPid(base, 999_999_9); // long dead / never existed
    const killed = await reapStrays(base);
    expect(killed).toEqual([pid]);
    expect(await listPids(base)).toEqual([]);
    await new Promise((resolve) => child.once("exit", resolve));
  });
});
```

`src/tests/unit/agent-manager.test.ts` (drivers injected as fakes; no
processes, fake timers for the accumulator):

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentDriver, StartTurnInput } from "@/ipc/agent/driver";
import {
  attachAgent,
  configureManager,
  detachAgent,
  interruptTurn,
  readHistory,
  respondPermission,
  send,
  setConfig,
  _resetManagerForTests,
} from "@/ipc/agent/manager";
import type { AgentEvent } from "@/types/agent";

const WT = "/wt/feat-a";
let base = "";

/** A driver whose event stream the test hand-feeds. */
function puppetDriver(id: "claude-code" | "codex" = "claude-code") {
  let push: ((event: AgentEvent | null) => void) | null = null;
  let lastInput: StartTurnInput | null = null;
  const driver: AgentDriver = {
    id,
    shutdown: () => Promise.resolve(),
    startTurn: (input) => {
      lastInput = input;
      const buffered: (AgentEvent | null)[] = [];
      let wake: (() => void) | null = null;
      push = (event) => {
        buffered.push(event);
        wake?.();
        wake = null;
      };
      return {
        events: (async function* () {
          for (;;) {
            const next = buffered.shift();
            if (next === null) {
              return;
            }
            if (next) {
              yield next;
              continue;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        })(),
        interrupt: () => {
          push?.({
            costUsd: null,
            kind: "turn-done",
            stopReason: "interrupted",
            turnId: "t1",
            usage: null,
          });
          push?.(null);
          return Promise.resolve();
        },
      };
    },
  };
  return {
    driver,
    end: () => push?.(null),
    feed: (event: AgentEvent) => push?.(event),
    input: () => lastInput,
  };
}

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "bw-manager-"));
  vi.useFakeTimers();
});
afterEach(async () => {
  vi.useRealTimers();
  _resetManagerForTests();
  await rm(base, { force: true, recursive: true });
});

async function pull(
  queue: ReturnType<typeof attachAgent>["queue"],
  count: number
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  const iterator = queue.iterate()[Symbol.asyncIterator]();
  while (out.length < count) {
    await vi.advanceTimersByTimeAsync(60);
    const { done, value } = await iterator.next();
    if (done) {
      break;
    }
    out.push(value);
  }
  return out;
}

describe("agent session manager", () => {
  test("send emits user-message, coalesces deltas, transcript survives", async () => {
    const puppet = puppetDriver();
    configureManager({ baseDir: base, drivers: { "claude-code": puppet.driver } });
    await setConfig(WT, { driverId: "claude-code", tier: "accept-edits" });

    const { queue, replay } = attachAgent(WT);
    expect(replay).toEqual([]);

    expect((await send(WT, "hello agent")).accepted).toBe(true);
    puppet.feed({ kind: "turn-started", turnId: "t1" });
    puppet.feed({ kind: "text-delta", text: "a" });
    puppet.feed({ kind: "text-delta", text: "b" });
    puppet.feed({ kind: "text-delta", text: "c" });
    puppet.feed({
      costUsd: 0.2,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "t1",
      usage: null,
    });
    puppet.end();

    const events = await pull(queue, 4);
    expect(events[0]).toEqual({ kind: "user-message", text: "hello agent" });
    expect(events[1]).toEqual({ kind: "turn-started", turnId: "t1" });
    // The three deltas crossed as one coalesced event (50ms tick or flush on
    // the non-delta turn-done, whichever came first).
    expect(events[2]).toEqual({ kind: "text-delta", text: "abc" });
    expect(events[3]).toMatchObject({ kind: "turn-done" });
    detachAgent(WT, queue);

    const history = await readHistory(WT);
    expect(history.map((e) => e.kind)).toEqual([
      "user-message",
      "turn-started",
      "text-delta",
      "turn-done",
    ]);
  });

  test("second send while a turn is active is refused", async () => {
    const puppet = puppetDriver();
    configureManager({ baseDir: base, drivers: { "claude-code": puppet.driver } });
    await setConfig(WT, { driverId: "claude-code", tier: "ask" });
    await send(WT, "one");
    const second = await send(WT, "two");
    expect(second.accepted).toBe(false);
    puppet.feed({
      costUsd: null,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "t1",
      usage: null,
    });
    puppet.end();
  });

  test("attach mid-turn replays flushed events; re-attach does not duplicate", async () => {
    const puppet = puppetDriver();
    configureManager({ baseDir: base, drivers: { "claude-code": puppet.driver } });
    await setConfig(WT, { driverId: "claude-code", tier: "accept-edits" });
    await send(WT, "hi");
    puppet.feed({ kind: "turn-started", turnId: "t1" });
    puppet.feed({ kind: "text-delta", text: "stream" });
    await vi.advanceTimersByTimeAsync(60);

    const first = attachAgent(WT);
    expect(first.replay.map((e) => e.kind)).toEqual([
      "user-message",
      "turn-started",
      "text-delta",
    ]);
    detachAgent(WT, first.queue);
    const second = attachAgent(WT);
    expect(second.replay).toEqual(first.replay);
    detachAgent(WT, second.queue);
    puppet.feed({
      costUsd: null,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "t1",
      usage: null,
    });
    puppet.end();
  });

  test("permission requests park until respondPermission, then resolve", async () => {
    const puppet = puppetDriver();
    configureManager({ baseDir: base, drivers: { "claude-code": puppet.driver } });
    await setConfig(WT, { driverId: "claude-code", tier: "ask" });
    await send(WT, "run it");

    let verdict: boolean | null = null;
    void puppet
      .input()
      ?.requestPermission({ detail: "npm test", requestId: "r1", toolName: "Bash" })
      .then((approved) => {
        verdict = approved;
      });
    await vi.advanceTimersByTimeAsync(10);
    expect(verdict).toBeNull();
    expect(respondPermission(WT, "r1", true)).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(verdict).toBe(true);
    // Both permission events must reach the transcript — the UI's approval
    // card and its resolution render from these, for both vendors.
    const history = await readHistory(WT);
    expect(
      history.some(
        (e) => e.kind === "permission-request" && e.requestId === "r1"
      )
    ).toBe(true);
    expect(
      history.some(
        (e) =>
          e.kind === "permission-resolved" &&
          e.requestId === "r1" &&
          e.approved === true
      )
    ).toBe(true);
    puppet.feed({
      costUsd: null,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "t1",
      usage: null,
    });
    puppet.end();
  });

  test("unanswered permission denies after the 5 minute timeout", async () => {
    const puppet = puppetDriver();
    configureManager({ baseDir: base, drivers: { "claude-code": puppet.driver } });
    await setConfig(WT, { driverId: "claude-code", tier: "ask" });
    await send(WT, "run it");
    let verdict: boolean | null = null;
    void puppet
      .input()
      ?.requestPermission({ detail: "x", requestId: "r2", toolName: "Bash" })
      .then((approved) => {
        verdict = approved;
      });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 50);
    expect(verdict).toBe(false);
    puppet.end();
  });

  test("interrupt reaches the driver and the turn closes", async () => {
    const puppet = puppetDriver();
    configureManager({ baseDir: base, drivers: { "claude-code": puppet.driver } });
    await setConfig(WT, { driverId: "claude-code", tier: "accept-edits" });
    await send(WT, "long task");
    puppet.feed({ kind: "turn-started", turnId: "t1" });
    await interruptTurn(WT);
    await vi.advanceTimersByTimeAsync(60);
    const history = await readHistory(WT);
    expect(history.at(-1)).toMatchObject({
      kind: "turn-done",
      stopReason: "interrupted",
    });
  });

  test("session ids persist into the registry via callbacks", async () => {
    const puppet = puppetDriver();
    configureManager({ baseDir: base, drivers: { "claude-code": puppet.driver } });
    await setConfig(WT, { driverId: "claude-code", tier: "accept-edits" });
    await send(WT, "hi");
    puppet.input()?.onSessionId("sess-42");
    puppet.feed({
      costUsd: null,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "t1",
      usage: null,
    });
    puppet.end();
    await vi.advanceTimersByTimeAsync(60);

    _resetManagerForTests();
    configureManager({ baseDir: base, drivers: { "claude-code": puppet.driver } });
    await send(WT, "again");
    expect(puppet.input()?.resume.sessionId).toBe("sess-42");
    puppet.end();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/tests/unit/agent-manager.test.ts src/tests/unit/agent-pids.test.ts`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement `pids.ts` and `manager.ts`**

`src/ipc/agent/pids.ts`:

```ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function pidFile(baseDir: string): string {
  return path.join(baseDir, "pids.json");
}

async function write(baseDir: string, pids: number[]): Promise<void> {
  await mkdir(baseDir, { recursive: true });
  const file = pidFile(baseDir);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(pids), "utf8");
  await rename(tmp, file);
}

export async function listPids(baseDir: string): Promise<number[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(pidFile(baseDir), "utf8"));
    return Array.isArray(parsed)
      ? parsed.filter((pid): pid is number => typeof pid === "number")
      : [];
  } catch {
    return [];
  }
}

export async function registerPid(baseDir: string, pid: number): Promise<void> {
  const pids = await listPids(baseDir);
  if (!pids.includes(pid)) {
    pids.push(pid);
  }
  await write(baseDir, pids);
}

export async function unregisterPid(baseDir: string, pid: number): Promise<void> {
  await write(
    baseDir,
    (await listPids(baseDir)).filter((entry) => entry !== pid)
  );
}

/**
 * Kills anything from a previous run that is still alive — the only cleanup
 * that survives a hard crash (atlas A3). Returns the pids it killed.
 */
export async function reapStrays(baseDir: string): Promise<number[]> {
  const killed: number[] = [];
  for (const pid of await listPids(baseDir)) {
    try {
      process.kill(pid, 0);
    } catch {
      continue; // already gone
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        continue;
      }
    }
    killed.push(pid);
  }
  await write(baseDir, []);
  return killed;
}
```

`src/ipc/agent/manager.ts`:

```ts
import path from "node:path";
import { EventQueue } from "@/lib/queue";
import type { AgentConfig, AgentDriverId, AgentEvent } from "@/types/agent";
import type { AgentDriver, AgentTurnHandle } from "./driver";
import { loadRegistry, saveRegistry } from "./registry";
import { appendTranscript, readTranscript } from "./transcript";

const FLUSH_MS = 50;
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

interface ActiveTurn {
  flushed: AgentEvent[]; // replay buffer for late attachers, this turn only
  handle: AgentTurnHandle;
  /** Delta runs in arrival order — only ADJACENT same-kind runs merge, so a
   * thinking→text transition can never flush inverted. */
  pendingDeltas: { kind: "text-delta" | "thinking-delta"; text: string }[];
  timer: NodeJS.Timeout | null;
}

/** Occupies the worktree's slot between the synchronous guard and startTurn. */
const RESERVED_TURN: ActiveTurn = {
  flushed: [],
  handle: {
    events: (async function* (): AsyncGenerator<AgentEvent> {})(),
    interrupt: () => Promise.resolve(),
  },
  pendingDeltas: [],
  timer: null,
};

let shuttingDown = false;

/**
 * Per-worktree emit chain: transcript appends and broadcasts happen strictly
 * in event order, even though each append awaits the filesystem. Without
 * this, a timer flush in flight can let a turn-done overtake its deltas.
 */
const emitChains = new Map<string, Promise<void>>();
function enqueueEmit(worktreePath: string, event: AgentEvent): Promise<void> {
  const tail = emitChains.get(worktreePath) ?? Promise.resolve();
  const next = tail.then(() => emit(worktreePath, event));
  emitChains.set(
    worktreePath,
    next.catch(() => {})
  );
  return next;
}

interface ManagerState {
  baseDir: string | null;
  drivers: Partial<Record<AgentDriverId, AgentDriver>>;
}

const state: ManagerState = { baseDir: null, drivers: {} };
const turns = new Map<string, ActiveTurn>();
const subscribers = new Map<string, Set<EventQueue<AgentEvent>>>();
const pendingPermissions = new Map<
  string,
  Map<string, { resolve: (approved: boolean) => void; timer: NodeJS.Timeout }>
>();

export function configureManager(options: {
  baseDir: string;
  drivers?: Partial<Record<AgentDriverId, AgentDriver>>;
}): void {
  state.baseDir = options.baseDir;
  if (options.drivers) {
    state.drivers = options.drivers;
  }
}

/** Test seam: forget every in-memory session (files on disk stay). */
export function _resetManagerForTests(): void {
  turns.clear();
  subscribers.clear();
  pendingPermissions.clear();
  state.baseDir = null;
  state.drivers = {};
}

async function baseDir(): Promise<string> {
  if (state.baseDir) {
    return state.baseDir;
  }
  const { app } = await import("electron");
  state.baseDir = path.join(app.getPath("userData"), "agent");
  return state.baseDir;
}

async function driverFor(id: AgentDriverId): Promise<AgentDriver> {
  const existing = state.drivers[id];
  if (existing) {
    return existing;
  }
  if (id === "claude-code") {
    const { createClaudeDriver } = await import("@/ipc/claude/adapter");
    state.drivers[id] = createClaudeDriver();
  } else {
    const { createCodexDriver } = await import("@/ipc/codex/adapter");
    const dir = await baseDir();
    state.drivers[id] = createCodexDriver({
      // Every spawned codex child lands in the pid file so a hard crash can
      // be reaped on next launch and a wedged child SIGKILLed at quit.
      onSpawn: (pid) => {
        void import("./pids").then(({ registerPid }) =>
          registerPid(dir, pid).catch(() => {})
        );
      },
    });
  }
  const created = state.drivers[id];
  if (!created) {
    throw new Error(`No driver for ${id}`);
  }
  return created;
}

function broadcast(worktreePath: string, event: AgentEvent): void {
  for (const queue of subscribers.get(worktreePath) ?? []) {
    queue.push(event);
  }
}

async function emit(worktreePath: string, event: AgentEvent): Promise<void> {
  // Capture the turn before awaiting: a turn that ends during the fs write
  // must not leak this event into its successor's replay buffer. Persist
  // before broadcasting so anything a subscriber has seen is already history.
  const turn = turns.get(worktreePath);
  await appendTranscript(await baseDir(), worktreePath, event);
  turn?.flushed.push(event);
  broadcast(worktreePath, event);
}

function flushDeltas(worktreePath: string): Promise<void> {
  const turn = turns.get(worktreePath);
  if (!turn) {
    return Promise.resolve();
  }
  const runs = turn.pendingDeltas;
  turn.pendingDeltas = [];
  if (turn.timer) {
    clearTimeout(turn.timer);
    turn.timer = null;
  }
  let last: Promise<void> = Promise.resolve();
  for (const run of runs) {
    last = enqueueEmit(worktreePath, { kind: run.kind, text: run.text });
  }
  return last;
}

function scheduleFlush(worktreePath: string): void {
  const turn = turns.get(worktreePath);
  if (!turn || turn.timer) {
    return;
  }
  turn.timer = setTimeout(() => {
    turn.timer = null;
    void flushDeltas(worktreePath);
  }, FLUSH_MS);
}

export async function getConfig(worktreePath: string): Promise<{
  config: AgentConfig;
  hasConversation: boolean;
  turnActive: boolean;
}> {
  const dir = await baseDir();
  const registry = await loadRegistry(dir);
  const entry = registry.worktrees[worktreePath];
  const history = await readTranscript(dir, worktreePath, 1);
  return {
    config: entry
      ? { driverId: entry.driverId, tier: entry.tier }
      : { driverId: registry.lastDriverId, tier: "accept-edits" },
    hasConversation: history.length > 0,
    turnActive: turns.has(worktreePath),
  };
}

export async function setConfig(
  worktreePath: string,
  config: AgentConfig
): Promise<void> {
  const dir = await baseDir();
  const registry = await loadRegistry(dir);
  const entry = registry.worktrees[worktreePath];
  registry.worktrees[worktreePath] = {
    driverId: config.driverId,
    sessionId: entry?.sessionId ?? null,
    threadId: entry?.threadId ?? null,
    tier: config.tier,
    updatedAt: Date.now(),
  };
  registry.lastDriverId = config.driverId;
  await saveRegistry(dir, registry);
}

async function persistIds(
  worktreePath: string,
  ids: { sessionId?: string; threadId?: string }
): Promise<void> {
  const dir = await baseDir();
  const registry = await loadRegistry(dir);
  const entry = registry.worktrees[worktreePath];
  if (!entry) {
    return;
  }
  registry.worktrees[worktreePath] = {
    ...entry,
    sessionId: ids.sessionId ?? entry.sessionId,
    threadId: ids.threadId ?? entry.threadId,
    updatedAt: Date.now(),
  };
  await saveRegistry(dir, registry);
}

export async function send(
  worktreePath: string,
  text: string
): Promise<{ accepted: boolean; reason?: string }> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { accepted: false, reason: "Empty message." };
  }
  if (shuttingDown) {
    return { accepted: false, reason: "branchwise is shutting down." };
  }
  if (turns.has(worktreePath)) {
    return { accepted: false, reason: "A turn is already running." };
  }
  // Synchronous reservation BEFORE any await: two sends racing through the
  // fs reads below must not both reach startTurn — the loser's agent would
  // run unreachable by interrupt or shutdown, billing into the void.
  turns.set(worktreePath, RESERVED_TURN);

  let handle: AgentTurnHandle;
  let resume: { sessionId: string | null; threadId: string | null };
  try {
    const dir = await baseDir();
    const registry = await loadRegistry(dir);
    const entry = registry.worktrees[worktreePath];
    const config: AgentConfig = entry
      ? { driverId: entry.driverId, tier: entry.tier }
      : { driverId: registry.lastDriverId, tier: "accept-edits" };
    if (!entry) {
      await setConfig(worktreePath, config);
    }
    resume = {
      sessionId: entry?.sessionId ?? null,
      threadId: entry?.threadId ?? null,
    };

    const driver = await driverFor(config.driverId);
    handle = driver.startTurn({
      onSessionId: (id) => void persistIds(worktreePath, { sessionId: id }),
      onThreadId: (id) => void persistIds(worktreePath, { threadId: id }),
      prompt: trimmed,
      requestPermission: (request) =>
        new Promise<boolean>((resolve) => {
          const forWorktree =
            pendingPermissions.get(worktreePath) ?? new Map();
          pendingPermissions.set(worktreePath, forWorktree);
          // The manager owns the permission EVENTS for both vendors: the
          // Claude SDK's callback cannot yield into its adapter's stream at
          // all, and every settle path (answer, timeout, interrupt, crash)
          // funnels through here — so this is the one place the request and
          // its resolution reliably reach the transcript and the UI.
          void enqueueEmit(worktreePath, {
            detail: request.detail,
            kind: "permission-request",
            requestId: request.requestId,
            toolName: request.toolName,
          });
          const settle = (approved: boolean) => {
            resolve(approved);
            void enqueueEmit(worktreePath, {
              approved,
              kind: "permission-resolved",
              requestId: request.requestId,
            });
          };
          const timer = setTimeout(() => {
            forWorktree.delete(request.requestId);
            settle(false);
          }, PERMISSION_TIMEOUT_MS);
          forWorktree.set(request.requestId, { resolve: settle, timer });
        }),
      resume,
      tier: config.tier,
      worktreePath,
    });
  } catch (error) {
    // The reservation must not outlive a failed start.
    turns.delete(worktreePath);
    return {
      accepted: false,
      reason:
        error instanceof Error ? error.message : "The agent could not start.",
    };
  }

  const turn: ActiveTurn = {
    flushed: [],
    handle,
    pendingDeltas: [],
    timer: null,
  };
  turns.set(worktreePath, turn); // replaces the reservation
  await enqueueEmit(worktreePath, { kind: "user-message", text: trimmed });

  void (async () => {
    try {
      for await (const event of handle.events) {
        const live = turns.get(worktreePath);
        if (live !== turn) {
          return; // superseded (shutdown raced a stream tail)
        }
        if (event.kind === "text-delta" || event.kind === "thinking-delta") {
          const last = turn.pendingDeltas.at(-1);
          if (last && last.kind === event.kind) {
            last.text += event.text;
          } else {
            turn.pendingDeltas.push({ kind: event.kind, text: event.text });
          }
          scheduleFlush(worktreePath);
          continue;
        }
        await flushDeltas(worktreePath);
        await enqueueEmit(worktreePath, event);
        if (event.kind === "turn-done") {
          turns.delete(worktreePath);
        }
      }
    } catch (error) {
      await flushDeltas(worktreePath);
      await enqueueEmit(worktreePath, {
        kind: "error",
        message:
          error instanceof Error ? error.message : "The agent stream failed.",
      });
      await enqueueEmit(worktreePath, {
        costUsd: null,
        kind: "turn-done",
        stopReason: "error",
        turnId: "stream",
        usage: null,
      });
    } finally {
      // Backstop: streams that end without a terminal event, and the crash
      // path, both free the slot; no parked permission waits out its five
      // minutes against a dead turn.
      if (turns.get(worktreePath) === turn) {
        turns.delete(worktreePath);
      }
      denyPendingPermissions(worktreePath);
    }
  })();

  return { accepted: true };
}

function denyPendingPermissions(worktreePath: string): void {
  const forWorktree = pendingPermissions.get(worktreePath);
  if (!forWorktree) {
    return;
  }
  for (const [, entry] of forWorktree) {
    clearTimeout(entry.timer);
    entry.resolve(false);
  }
  pendingPermissions.delete(worktreePath);
}

export function attachAgent(worktreePath: string): {
  queue: EventQueue<AgentEvent>;
  replay: AgentEvent[];
} {
  const queue = new EventQueue<AgentEvent>({
    merge: (left, right) =>
      left.kind === "text-delta" && right.kind === "text-delta"
        ? { kind: "text-delta", text: left.text + right.text }
        : left.kind === "thinking-delta" && right.kind === "thinking-delta"
          ? { kind: "thinking-delta", text: left.text + right.text }
          : null,
  });
  const existing =
    subscribers.get(worktreePath) ?? new Set<EventQueue<AgentEvent>>();
  existing.add(queue);
  subscribers.set(worktreePath, existing);
  return { queue, replay: [...(turns.get(worktreePath)?.flushed ?? [])] };
}

export function detachAgent(
  worktreePath: string,
  queue: EventQueue<AgentEvent>
): void {
  const queues = subscribers.get(worktreePath);
  queues?.delete(queue);
  if (queues && queues.size === 0) {
    subscribers.delete(worktreePath);
  }
  queue.close();
}

export async function interruptTurn(worktreePath: string): Promise<void> {
  await turns.get(worktreePath)?.handle.interrupt();
}

export function respondPermission(
  worktreePath: string,
  requestId: string,
  approved: boolean
): boolean {
  const entry = pendingPermissions.get(worktreePath)?.get(requestId);
  if (!entry) {
    return false;
  }
  pendingPermissions.get(worktreePath)?.delete(requestId);
  clearTimeout(entry.timer);
  entry.resolve(approved);
  return true;
}

export async function readHistory(worktreePath: string): Promise<AgentEvent[]> {
  return await readTranscript(await baseDir(), worktreePath);
}

/** Quit-time teardown: interrupt, shut drivers down, reap what's left. */
export async function shutdownAgents(timeoutMs = 2000): Promise<void> {
  shuttingDown = true; // sends mid-flight refuse from here on
  const work = (async () => {
    await Promise.all(
      [...turns.keys()].map((worktreePath) => interruptTurn(worktreePath))
    );
    await Promise.all(
      Object.values(state.drivers).map((driver) => driver?.shutdown())
    );
  })();
  await Promise.race([
    work,
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  for (const worktreePath of [...pendingPermissions.keys()]) {
    denyPendingPermissions(worktreePath);
  }
  const { reapStrays } = await import("./pids");
  await reapStrays(await baseDir()).catch(() => []);
}
```

Note for the implementer: adapters register their child pids with
`registerPid`/`unregisterPid` — wire that in this task by threading
`baseDir()` through a small `trackPid(pid)` helper exported from the manager
and called by `spawnCodexAppServer`'s caller (`createCodexDriver` via an
optional `onSpawn?: (pid: number) => void` dependency) and by the Claude
driver when the SDK exposes a child pid (if the SDK version does not expose
one, Claude cleanup rides on `AbortController` + SDK's own kill — record that
in the commit message).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/tests/unit/agent-manager.test.ts src/tests/unit/agent-pids.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire quit teardown in `src/main.ts`**

Replace the current handler at `src/main.ts:105-111`:

```ts
// Shells stop synchronously (they always did); agents need a bounded async
// window: interrupt, SIGTERM, then SIGKILL via the pid file. The flag is set
// in the completion handler BEFORE quit() so the re-entrant quit passes, and
// a failed import must still quit — an unquittable app is worse than an
// unreaped agent (startup reap covers those).
let agentsShutDown = false;
app.on("before-quit", (event) => {
  killAll();
  stopAllWatching();
  if (!agentsShutDown) {
    event.preventDefault();
    void import("./ipc/agent/manager")
      .then(({ shutdownAgents }) => shutdownAgents(2000))
      .catch(() => {})
      .finally(() => {
        agentsShutDown = true;
        app.quit();
      });
  }
});
```

And near app startup (inside the existing `app.whenReady()` chain), reap
strays from a previous crash — static imports at the top of `main.ts`, matching
its existing style (`killAll` is already imported statically):

```ts
import path from "node:path";
import { reapStrays } from "./ipc/agent/pids";
// … inside the whenReady handler, non-blocking:
void reapStrays(path.join(app.getPath("userData"), "agent"));
```

- [ ] **Step 6: Full gate and commit**

Run: `npx tsc --noEmit --skipLibCheck && npx vitest run`
Expected: clean, all green.

```bash
git add src/ipc/agent/manager.ts src/ipc/agent/pids.ts src/main.ts src/tests/unit/agent-manager.test.ts src/tests/unit/agent-pids.test.ts
git commit -m "Run agent turns through a per-worktree session manager with clean teardown"
```

---

### Task 10: oRPC surface

**Files:**
- Create: `src/ipc/agent/handlers.ts`
- Create: `src/ipc/agent/index.ts`
- Modify: `src/ipc/router.ts`
- Test: `src/tests/unit/agent-handlers.test.ts`

**Interfaces:**
- Consumes: manager (Task 9), `agentEventSchema`, `agentConfigSchema` (Task 1).
- Produces oRPC procedures under `router.agent`: `attach { worktreePath }` → eventIterator(agentEventSchema) (replay then live, terminal-attach style); `send { worktreePath, text }` → `{ accepted, reason? }`; `interrupt { worktreePath }` → `{ ok: true }`; `respondPermission { worktreePath, requestId, approved }` → `{ ok: boolean }`; `getConfig { worktreePath }` → `{ config, hasConversation, turnActive }`; `setConfig { worktreePath, config }` → `{ ok: true }`; `history { worktreePath }` → `AgentEvent[]`.

- [ ] **Step 1: Write the failing test**

`src/tests/unit/agent-handlers.test.ts` — call the handlers directly (oRPC
`os` procedures are callable in-process via `.callable()`; follow the pattern:
`const called = await attach.callable()({ worktreePath })`). Test: `history`
returns what the manager wrote; `attach` yields replayed events then closes on
abort; `send` refuses empty text. Reuse `configureManager` + `puppetDriver`
from Task 9's test (extract `puppetDriver` into
`src/tests/unit/helpers/puppet-driver.ts` in this step and update Task 9's
test imports).

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  attach,
  history,
  respondPermissionRoute,
  sendMessage,
} from "@/ipc/agent/handlers";
import {
  _resetManagerForTests,
  configureManager,
  setConfig,
} from "@/ipc/agent/manager";
import { puppetDriver } from "./helpers/puppet-driver";

let base = "";
const WT = "/wt/feat-x";

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "bw-handlers-"));
});
afterEach(async () => {
  _resetManagerForTests();
  await rm(base, { force: true, recursive: true });
});

describe("agent handlers", () => {
  test("send + history round-trip through the oRPC layer", async () => {
    const puppet = puppetDriver();
    configureManager({ baseDir: base, drivers: { "claude-code": puppet.driver } });
    await setConfig(WT, { driverId: "claude-code", tier: "accept-edits" });

    const send = sendMessage.callable();
    expect(await send({ text: "hello", worktreePath: WT })).toEqual({
      accepted: true,
    });
    puppet.feed({
      costUsd: null,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "t1",
      usage: null,
    });
    puppet.end();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const readBack = await history.callable()({ worktreePath: WT });
    expect(readBack.map((event) => event.kind)).toEqual([
      "user-message",
      "turn-done",
    ]);
  });

  test("attach replays then ends when the client aborts", async () => {
    const puppet = puppetDriver();
    configureManager({ baseDir: base, drivers: { "claude-code": puppet.driver } });
    await setConfig(WT, { driverId: "claude-code", tier: "accept-edits" });
    await sendMessage.callable()({ text: "hi", worktreePath: WT });

    const controller = new AbortController();
    const stream = await attach.callable()(
      { worktreePath: WT },
      { signal: controller.signal }
    );
    const seen: string[] = [];
    const consuming = (async () => {
      for await (const event of stream) {
        seen.push(event.kind);
        if (seen.length >= 1) {
          controller.abort();
        }
      }
    })().catch(() => {});
    await consuming;
    expect(seen[0]).toBe("user-message");
    puppet.end();
  });

  test("empty text is refused", async () => {
    configureManager({ baseDir: base, drivers: {} });
    const result = await sendMessage.callable()({
      text: "   ",
      worktreePath: WT,
    });
    expect(result.accepted).toBe(false);
  });

  test("responding to an unknown permission returns ok:false", async () => {
    configureManager({ baseDir: base, drivers: {} });
    const result = await respondPermissionRoute.callable()({
      approved: true,
      requestId: "nope",
      worktreePath: WT,
    });
    expect(result.ok).toBe(false);
  });
});
```

(If `.callable()` differs in the installed oRPC version, follow how existing
handler tests invoke procedures — check `src/tests/unit` for repo precedent,
and if none exists, export the plain implementation functions from
`handlers.ts` alongside the `os` wrappers and test those.)

- [ ] **Step 2: Run to verify failure, then implement**

`src/ipc/agent/handlers.ts`:

```ts
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
    worktreeInput.extend({ approved: z.boolean(), requestId: z.string().min(1) })
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
```

(Adjust the test import name: `respondPermission as respondPermissionHandler`
→ `respondPermissionRoute`.)

`src/ipc/agent/index.ts`:

```ts
import {
  attach,
  getAgentConfig,
  history,
  interrupt,
  respondPermissionRoute,
  sendMessage,
  setAgentConfig,
} from "./handlers";

export const agent = {
  attach,
  getConfig: getAgentConfig,
  history,
  interrupt,
  respondPermission: respondPermissionRoute,
  send: sendMessage,
  setConfig: setAgentConfig,
};
```

`src/ipc/router.ts` — add `import { agent } from "./agent";` and `agent,` to
the router object.

- [ ] **Step 3: Run tests, typecheck, commit**

Run: `npx vitest run src/tests/unit/agent-handlers.test.ts && npx tsc --noEmit --skipLibCheck`

```bash
git add src/ipc/agent/handlers.ts src/ipc/agent/index.ts src/ipc/router.ts src/tests/unit/agent-handlers.test.ts src/tests/unit/helpers/puppet-driver.ts src/tests/unit/agent-manager.test.ts
git commit -m "Expose the agent session manager over oRPC"
```

---

### Task 11: Renderer actions and store rewrite

**Files:**
- Create: `src/actions/agent.ts`
- Rewrite: `src/stores/agent-store.ts`
- Modify: `src/components/canvas/branch-node.tsx:8-10,95-99` (badge derivation)
- Delete test: `src/tests/unit/agent-tasks.test.ts`
- Test: `src/tests/unit/agent-store.test.ts`
- Test: `src/tests/unit/agent-import-boundary.test.ts`

**Interfaces:**
- Consumes: oRPC client (`ipc.client.agent.*`, Task 10), `foldEvent`/`emptyConversation`/`ConversationState` (Task 1), types (Task 1).
- Produces `src/actions/agent.ts`:

```ts
import { ipc } from "@/ipc/manager";
import type { AgentConfig, AgentEvent } from "@/types/agent";

export function attachAgent(
  worktreePath: string,
  signal: AbortSignal
): Promise<AsyncIterable<AgentEvent>> {
  return ipc.client.agent.attach({ worktreePath }, { signal });
}

export function sendAgentMessage(
  worktreePath: string,
  text: string
): Promise<{ accepted: boolean; reason?: string }> {
  return ipc.client.agent.send({ text, worktreePath });
}

export function interruptAgent(worktreePath: string): Promise<{ ok: true }> {
  return ipc.client.agent.interrupt({ worktreePath });
}

export function respondAgentPermission(input: {
  approved: boolean;
  requestId: string;
  worktreePath: string;
}): Promise<{ ok: boolean }> {
  return ipc.client.agent.respondPermission(input);
}

export function getAgentConfig(worktreePath: string) {
  return ipc.client.agent.getConfig({ worktreePath });
}

export function setAgentConfig(worktreePath: string, config: AgentConfig) {
  return ipc.client.agent.setConfig({ config, worktreePath });
}

export function agentHistory(worktreePath: string): Promise<AgentEvent[]> {
  return ipc.client.agent.history({ worktreePath });
}
```

- Produces `src/stores/agent-store.ts` (zustand, replaces the canned pool):
  - State: `sessions: Record<string, AgentSession>` keyed by worktreePath, where `AgentSession = { conversation: ConversationState; config: AgentConfig | null; hasConversation: boolean; attached: boolean; sending: boolean }`.
  - Actions: `open(worktreePath)` — loads config + history (`agentHistory` folded through `foldEvent`), then attaches (`attachAgent`) with an internal `AbortController`, folding live events; replayed active-turn events are deduplicated by folding into the history-derived state only events after the last folded one is impossible to detect generically, so `open()` folds history first, then attach replay/live events on top — the manager's replay only covers the *active turn* which is not yet in the transcript-history split point; to keep v1 simple and correct, `open()` calls history() and attach() but ignores replayed duplicates by resetting: fold history, then fold every attach event; since active-turn events are both in replay and (already) in the transcript, `open()` must fold history *excluding* the active turn — implement by having `attach`'s replay carry the authoritative active-turn tail and `history` stop at the last `turn-done`: in `open()`, trim folded history back to the last `turn-done` boundary (drop trailing events after it) before folding attach events. Unit-tested below.
  - `close(worktreePath)` — aborts the attach, marks detached (state retained for fast reopen).
  - `sendMessage(worktreePath, text)`, `interrupt(worktreePath)`, `respond(worktreePath, requestId, approved)`, `configure(worktreePath, config)`.
  - Selector helpers: `selectSession(state, worktreePath)`; `agentActivity(session)` → `{ running: boolean; needsPermission: boolean }` (replaces `countTasks` for the node badge).
- `branch-node.tsx` swaps `countTasks(items)` for `agentActivity`: running = `conversation.activeTurnId !== null`, needsPermission = any item `kind === "permission" && state === "pending"`. Update the badge rendering minimally (keep visual shape; a pending-permission badge may reuse the existing "pending" styling).
- The import-boundary test walks `src/stores` and `src/components` sources and fails on `@anthropic-ai/claude-agent-sdk` or `@/ipc/claude/`, `@/ipc/codex/` imports:

```ts
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

const FORBIDDEN = [
  "@anthropic-ai/claude-agent-sdk",
  "@/ipc/claude/",
  "@/ipc/codex/",
];

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await sourceFiles(full)));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("vendor import boundary (atlas A1)", () => {
  test("stores and components never import vendor modules", async () => {
    const roots = ["src/stores", "src/components"].map((p) =>
      path.resolve(process.cwd(), p)
    );
    for (const root of roots) {
      for (const file of await sourceFiles(root)) {
        const source = await readFile(file, "utf8");
        for (const forbidden of FORBIDDEN) {
          expect(
            source.includes(forbidden),
            `${file} imports ${forbidden}`
          ).toBe(false);
        }
      }
    }
  });
});
```

- [ ] **Step 1: Write the failing store test**

`src/tests/unit/agent-store.test.ts`:

```ts
import { afterEach, describe, expect, test } from "vitest";
import {
  _setAgentActionsForTests,
  agentActivity,
  selectSession,
  useAgentStore,
} from "@/stores/agent-store";
import type { AgentEvent } from "@/types/agent";

const WT = "/wt/feat-a";

/** A controllable fake of src/actions/agent.ts. */
function fakeActions(history: AgentEvent[], replayThenLive: AgentEvent[]) {
  const calls: Record<string, unknown[]> = {
    interrupt: [],
    respond: [],
    send: [],
    setConfig: [],
  };
  let releaseLive: (() => void) | null = null;
  const actions = {
    agentHistory: () => Promise.resolve(history),
    attachAgent: (_wt: string, signal: AbortSignal) =>
      Promise.resolve(
        (async function* () {
          for (const event of replayThenLive) {
            if (signal.aborted) {
              return;
            }
            yield event;
          }
          await new Promise<void>((resolve) => {
            releaseLive = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        })()
      ),
    getAgentConfig: () =>
      Promise.resolve({
        config: { driverId: "claude-code" as const, tier: "accept-edits" as const },
        hasConversation: history.length > 0,
        turnActive: false,
      }),
    interruptAgent: (wt: string) => {
      calls.interrupt.push(wt);
      return Promise.resolve({ ok: true as const });
    },
    respondAgentPermission: (input: unknown) => {
      calls.respond.push(input);
      return Promise.resolve({ ok: true });
    },
    sendAgentMessage: (wt: string, text: string) => {
      calls.send.push([wt, text]);
      return Promise.resolve({ accepted: true });
    },
    setAgentConfig: (wt: string, config: unknown) => {
      calls.setConfig.push([wt, config]);
      return Promise.resolve({ ok: true as const });
    },
  };
  return { actions, calls, end: () => releaseLive?.() };
}

afterEach(() => {
  useAgentStore.getState().reset();
});

const DONE: AgentEvent = {
  costUsd: null,
  kind: "turn-done",
  stopReason: "completed",
  turnId: "t0",
  usage: null,
};

describe("agent store", () => {
  test("open folds history, trims the unfinished tail, then folds live events", async () => {
    // History ends mid-turn (user-message after the last turn-done); the
    // attach replay re-delivers that active turn, so the trim prevents the
    // duplicate user bubble.
    const history: AgentEvent[] = [
      { kind: "user-message", text: "first" },
      DONE,
      { kind: "user-message", text: "second" },
    ];
    const replay: AgentEvent[] = [
      { kind: "user-message", text: "second" },
      { kind: "turn-started", turnId: "t1" },
      { kind: "text-delta", text: "wor" },
    ];
    const fake = fakeActions(history, replay);
    _setAgentActionsForTests(fake.actions);

    await useAgentStore.getState().open(WT);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const session = selectSession(useAgentStore.getState(), WT);
    const userItems = session.conversation.items.filter(
      (item) => item.kind === "user"
    );
    expect(userItems.map((item) => item.kind === "user" && item.text)).toEqual([
      "first",
      "second",
    ]);
    expect(session.conversation.streamingText).toBe("wor");
    expect(agentActivity(session)).toEqual({
      needsPermission: false,
      running: true,
    });
    fake.end();
  });

  test("pending permission flips needsPermission; respond passes through", async () => {
    const fake = fakeActions(
      [],
      [
        { kind: "turn-started", turnId: "t1" },
        {
          detail: "npm test",
          kind: "permission-request",
          requestId: "r1",
          toolName: "Bash",
        },
      ]
    );
    _setAgentActionsForTests(fake.actions);
    await useAgentStore.getState().open(WT);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(
      agentActivity(selectSession(useAgentStore.getState(), WT))
    ).toEqual({ needsPermission: true, running: true });

    await useAgentStore.getState().respond(WT, "r1", true);
    expect(fake.calls.respond).toEqual([
      { approved: true, requestId: "r1", worktreePath: WT },
    ]);
    fake.end();
  });

  test("sendMessage delegates and close aborts the live stream", async () => {
    const fake = fakeActions([], []);
    _setAgentActionsForTests(fake.actions);
    await useAgentStore.getState().open(WT);
    await useAgentStore.getState().sendMessage(WT, "do it");
    expect(fake.calls.send).toEqual([[WT, "do it"]]);
    useAgentStore.getState().close(WT);
    expect(selectSession(useAgentStore.getState(), WT).attached).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/tests/unit/agent-store.test.ts`.

- [ ] **Step 3: Implement the store** (actions file code is in Interfaces above; branch-node change and deletion of the canned pool follow):

`src/stores/agent-store.ts`:

```ts
import { create } from "zustand";
import * as realActions from "@/actions/agent";
import {
  type ConversationState,
  emptyConversation,
  foldEvent,
} from "@/lib/agent/fold";
import type { AgentConfig, AgentEvent } from "@/types/agent";

export interface AgentSession {
  attached: boolean;
  config: AgentConfig | null;
  conversation: ConversationState;
  hasConversation: boolean;
}

type AgentActionsShape = Pick<
  typeof realActions,
  | "agentHistory"
  | "attachAgent"
  | "getAgentConfig"
  | "interruptAgent"
  | "respondAgentPermission"
  | "sendAgentMessage"
  | "setAgentConfig"
>;

let actions: AgentActionsShape = realActions;

/** Test seam: swap the IPC-backed actions for fakes. */
export function _setAgentActionsForTests(fake: AgentActionsShape): void {
  actions = fake;
}

const EMPTY_SESSION: AgentSession = {
  attached: false,
  config: null,
  conversation: emptyConversation(),
  hasConversation: false,
};

/**
 * The transcript contains every event ever flushed, including the active
 * turn's; the attach replay re-delivers exactly that active turn. Trimming
 * history back to its last turn-done removes the overlap, so fold(history') +
 * fold(replay + live) is duplicate-free and deterministic.
 */
export function trimToLastTurnDone(events: AgentEvent[]): AgentEvent[] {
  const lastDone = events.findLastIndex((event) => event.kind === "turn-done");
  return lastDone < 0 ? [] : events.slice(0, lastDone + 1);
}

interface AgentStoreState {
  sessions: Record<string, AgentSession>;
  open: (worktreePath: string) => Promise<void>;
  close: (worktreePath: string) => void;
  sendMessage: (worktreePath: string, text: string) => Promise<void>;
  interrupt: (worktreePath: string) => Promise<void>;
  respond: (
    worktreePath: string,
    requestId: string,
    approved: boolean
  ) => Promise<void>;
  configure: (worktreePath: string, config: AgentConfig) => Promise<void>;
  reset: () => void;
}

const controllers = new Map<string, AbortController>();

export const useAgentStore = create<AgentStoreState>()((set, get) => {
  function patch(
    worktreePath: string,
    update: (session: AgentSession) => AgentSession
  ): void {
    set((state) => ({
      sessions: {
        ...state.sessions,
        [worktreePath]: update(state.sessions[worktreePath] ?? EMPTY_SESSION),
      },
    }));
  }

  return {
    close: (worktreePath) => {
      controllers.get(worktreePath)?.abort();
      controllers.delete(worktreePath);
      patch(worktreePath, (session) => ({ ...session, attached: false }));
    },

    configure: async (worktreePath, config) => {
      await actions.setAgentConfig(worktreePath, config);
      patch(worktreePath, (session) => ({ ...session, config }));
    },

    interrupt: async (worktreePath) => {
      await actions.interruptAgent(worktreePath);
    },

    open: async (worktreePath) => {
      controllers.get(worktreePath)?.abort();
      const controller = new AbortController();
      controllers.set(worktreePath, controller);

      const [meta, history] = await Promise.all([
        actions.getAgentConfig(worktreePath),
        actions.agentHistory(worktreePath),
      ]);
      const folded = trimToLastTurnDone(history).reduce(
        foldEvent,
        emptyConversation()
      );
      patch(worktreePath, () => ({
        attached: true,
        config: meta.config,
        conversation: folded,
        hasConversation: meta.hasConversation,
      }));

      const stream = await actions.attachAgent(worktreePath, controller.signal);
      void (async () => {
        try {
          for await (const event of stream) {
            if (controller.signal.aborted) {
              return;
            }
            patch(worktreePath, (session) => ({
              ...session,
              conversation: foldEvent(session.conversation, event),
              hasConversation: true,
            }));
          }
        } catch {
          // Stream ended by reload/abort: state stays; reopen re-syncs.
        }
      })();
    },

    reset: () => {
      for (const controller of controllers.values()) {
        controller.abort();
      }
      controllers.clear();
      set({ sessions: {} });
    },

    respond: async (worktreePath, requestId, approved) => {
      await actions.respondAgentPermission({
        approved,
        requestId,
        worktreePath,
      });
    },

    sendMessage: async (worktreePath, text) => {
      await actions.sendAgentMessage(worktreePath, text);
    },

    sessions: {},
  };
});

export function selectSession(
  state: AgentStoreState,
  worktreePath: string
): AgentSession {
  return state.sessions[worktreePath] ?? EMPTY_SESSION;
}

/** Node-badge derivation; replaces countTasks. */
export function agentActivity(session: AgentSession): {
  needsPermission: boolean;
  running: boolean;
} {
  return {
    needsPermission: session.conversation.items.some(
      (item) => item.kind === "permission" && item.state === "pending"
    ),
    running: session.conversation.activeTurnId !== null,
  };
}
```

In `src/components/canvas/branch-node.tsx`, replace the `countTasks` import
and usage (lines 8-10 and 95-99) with:

```ts
import { agentActivity, selectSession, useAgentStore } from "@/stores/agent-store";
// …
const session = useAgentStore((state) => selectSession(state, node.id));
const activity = useMemo(() => agentActivity(session), [session]);
```

and render the badge from `activity.running` / `activity.needsPermission`
(keep the existing dot styling; map needsPermission to the "pending" visual
until A5's ladder lands). Note the store key is the worktree path — `node.id`
is the worktree path in the current model.

- [ ] **Step 4: Run the boundary test and full suite** — `npx vitest run` (expect the old `agent-tasks.test.ts` removed, everything green), `npx tsc --noEmit --skipLibCheck`.

- [ ] **Step 5: Commit**

```bash
git add src/actions/agent.ts src/stores/agent-store.ts src/components/canvas/branch-node.tsx src/tests/unit/agent-store.test.ts src/tests/unit/agent-import-boundary.test.ts
git rm src/tests/unit/agent-tasks.test.ts
git commit -m "Fold real agent events into the renderer store"
```

---

### Task 12: Agent tab UI

**Files:**
- Rewrite: `src/components/panel/agent-tab.tsx`
- Create: `src/components/panel/agent-cards.tsx` (ToolCard, PermissionCard, NoticeCard)
- Create: `src/components/panel/agent-config-bar.tsx` (driver picker + tier picker)
- Modify: `src/components/panel/node-panel.tsx` (AgentTab call site: pass `worktreePath={node.id}` and `branchLabel`; drop the old `nodeId`/`projectFolder` props)
- Test: `src/tests/unit/agent-tab.test.tsx`

**Interfaces:**
- Consumes: store (Task 11) only — no direct IPC.
- Produces: the working Agent tab. Layout stays the existing shell (scroll area + composer). New behavior:
  - On mount (per `worktreePath`): `open(worktreePath)`; on unmount `close(worktreePath)`.
  - Config bar above the composer: driver picker (`Claude Code` / `Codex`) enabled only while `!hasConversation`; tier picker with the four tiers, `yolo` rendered with a warning treatment (`text-bw-danger` if the token exists — check `src/styles`; otherwise a red-600 utility) and a confirm click-through (`window.confirm` is fine for v1).
  - Messages render from `conversation.items` (user bubble, assistant text + collapsible thinking via `<details>`, ToolCard with running/ok/error dot reusing the existing STATUS dot pattern, PermissionCard with Approve / Deny buttons calling `respond`, NoticeCard for errors).
  - Streaming: `conversation.streamingText` renders as the in-progress assistant message with the existing "Thinking…" affordance replaced by live text; composer disabled while `activeTurnId !== null`; an Interrupt button appears during a turn.
  - Cost line under the last assistant message when `costUsd !== null`: `≈ $0.37 · 1.2k in / 88 out` (label as estimate).
  - Agent output renders as plain text (`whitespace-pre-wrap`), no markdown/HTML in v1 (untrusted content, atlas security edge).
- Component test (`@testing-library/react` is already in devDependencies per `toggle-theme.test.tsx` — follow its render/setup idiom): permission card fires `respond` with approved=true/false; composer disabled while a turn is active; driver picker locked once `hasConversation`.

- [ ] **Step 1: Write the failing component test**

`src/tests/unit/agent-tab.test.tsx` (follow `toggle-theme.test.tsx` for the
render/setup idiom):

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import AgentTab from "@/components/panel/agent-tab";
import { emptyConversation } from "@/lib/agent/fold";
import {
  _setAgentActionsForTests,
  useAgentStore,
} from "@/stores/agent-store";
import type { AgentEvent } from "@/types/agent";

const WT = "/wt/feat-a";

function stubActions() {
  const respond = vi.fn(() => Promise.resolve({ ok: true }));
  _setAgentActionsForTests({
    agentHistory: () => Promise.resolve([] as AgentEvent[]),
    attachAgent: () =>
      Promise.resolve(
        (async function* () {
          await new Promise(() => {}); // never yields, never ends
        })()
      ),
    getAgentConfig: () =>
      Promise.resolve({
        config: { driverId: "claude-code" as const, tier: "accept-edits" as const },
        hasConversation: false,
        turnActive: false,
      }),
    interruptAgent: () => Promise.resolve({ ok: true as const }),
    respondAgentPermission: respond,
    sendAgentMessage: () => Promise.resolve({ accepted: true }),
    setAgentConfig: () => Promise.resolve({ ok: true as const }),
  });
  return { respond };
}

function seedSession(overrides: {
  activeTurnId?: string | null;
  hasConversation?: boolean;
  pendingPermission?: boolean;
}) {
  const conversation = emptyConversation();
  conversation.activeTurnId = overrides.activeTurnId ?? null;
  if (overrides.pendingPermission) {
    conversation.items = [
      {
        detail: "rm -rf build",
        id: "perm-r1",
        kind: "permission",
        requestId: "r1",
        state: "pending",
        toolName: "Bash",
      },
    ];
  }
  useAgentStore.setState({
    sessions: {
      [WT]: {
        attached: true,
        config: { driverId: "claude-code", tier: "accept-edits" },
        conversation,
        hasConversation: overrides.hasConversation ?? false,
      },
    },
  });
}

afterEach(() => {
  useAgentStore.getState().reset();
});

describe("AgentTab", () => {
  test("permission card approve/deny call respond with the request id", () => {
    const { respond } = stubActions();
    seedSession({ activeTurnId: "t1", pendingPermission: true });
    render(<AgentTab branchLabel="feat-a" worktreePath={WT} />);
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    expect(respond).toHaveBeenCalledWith({
      approved: true,
      requestId: "r1",
      worktreePath: WT,
    });
  });

  test("composer is disabled while a turn is active, interrupt appears", () => {
    stubActions();
    seedSession({ activeTurnId: "t1" });
    render(<AgentTab branchLabel="feat-a" worktreePath={WT} />);
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /interrupt/i })
    ).toBeInTheDocument();
  });

  test("driver picker locks once a conversation exists", () => {
    stubActions();
    seedSession({ hasConversation: true });
    render(<AgentTab branchLabel="feat-a" worktreePath={WT} />);
    expect(screen.getByLabelText(/agent backend/i)).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/tests/unit/agent-tab.test.tsx`.
- [ ] **Step 3: Implement the three component files and the node-panel call site.** Keep `agent-tab.tsx` under ~250 lines by pushing cards and config bar into their files. `AgentTab` props become `{ branchLabel: string; worktreePath: string }`. The driver picker is a labelled `<select aria-label="Agent backend">` with the two drivers; the tier picker a second select with the four tiers plus a `window.confirm` gate and warning styling when switching to yolo. The composer keeps the existing textarea/submit styling; disabled + Interrupt button while `conversation.activeTurnId !== null`; streaming text renders below the last item with `whitespace-pre-wrap`; thinking renders inside `<details><summary>thinking</summary>…</details>`.
- [ ] **Step 4: Run the full gates** — `npx vitest run && npx tsc --noEmit --skipLibCheck && npm run package`.
- [ ] **Step 5: Manual smoke (dev, real CLIs, not CI):** `npm start`, open a repo with a worktree, send a message on a node with each driver, watch streaming + a permission card, interrupt once, quit mid-turn and relaunch to confirm the conversation rebuilds and no `claude`/`codex` processes survive (`ps aux | grep -E 'claude|codex'`). Record results in the commit message.
- [ ] **Step 6: Commit**

```bash
git add src/components/panel/agent-tab.tsx src/components/panel/agent-cards.tsx src/components/panel/agent-config-bar.tsx src/tests/unit/agent-tab.test.tsx
git commit -m "Rebuild the Agent tab on live streams, approvals and tiers"
```

---

## Self-review checklist (run after Task 12)

1. Spec coverage: §1 vocabulary+boundary → Tasks 1, 11; §2 manager/A3/A4-lite/persistence → Tasks 2, 9; §3 adapters+tier table → Tasks 3–8; §4 renderer → Tasks 11–12; §6 tests → throughout; §7 exclusions honored (no tray, no steer, no model picker).
2. The A2-ordering requirement (cwd/env test first) is Task 4 and it precedes every process-touching task.
3. Increment 2 (inheritance) is deliberately absent — separate plan.
4. `npx tsc --noEmit --skipLibCheck` + `npx vitest run` + `npm run package` all green before calling the increment done.
