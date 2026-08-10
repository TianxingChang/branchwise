# Context inheritance across child worktrees — implementation plan

Increment 2 of the agent runtime (spec §5,
`docs/superpowers/specs/2026-08-09-agent-runtime-design.md`). When a child
worktree is created from a parent whose node has a conversation, the child's
agent inherits context: a deterministic **brief** by default, **full history**
by explicit opt-in. Everything builds on increment 1's landed runtime
(vocabulary, transcripts, registry, both drivers, manager, oRPC, store, UI).

**Spike results already banked (controller-verified 2026-08-10, do not
re-derive):**

- `claude --resume <parentSessionId> --fork-session` from a DIFFERENT cwd
  finds the parent session, carries its context (fork answered a codeword
  planted in the parent), and mints a fresh session id. The SDK exposes it as
  `forkSession?: boolean` beside `resume` (sdk.d.ts:1524, pinned 0.3.226).
  The spec's "expected to fail → inline transcript fallback" branch is dead;
  native fork is the cc full-history path.
- codex on this machine cannot complete any turn until the user runs
  `codex update` (backend version skew, see memory) — codex-side work in this
  increment is fixture-tested only, like increment 1; the wire shapes
  (`thread/inject_items`) are canvas-proven.

**Standing rules (unchanged from increment 1):** TDD per task; tests in
`src/tests/unit` with explicit vitest imports; biome/ultracite style; no
vendor types outside adapters; transcripts/registry/pending files only under
`baseDir` (never a user repo); gates per task = scoped vitest + full
`npx vitest run` + `npx tsc --noEmit --skipLibCheck` + `npm run check` on
touched files; commit message per task, lowercase imperative, no attribution.

**Path-poisoning hazard (spec §5, recorded):** the brief tier rewrites file
mentions to repo-relative paths; the full tier carries a leading context note
("the working directory changed from <parent> to <child>; map any old
absolute paths onto the new root") and residual risk is user-accepted.

---

## Task 1: The brief digest and history extraction (pure)

**Files:**
- Create: `src/lib/agent/inherit.ts`
- Create: `src/tests/unit/agent-inherit.test.ts`

**Depends on:** nothing new (consumes `AgentEvent` from `@/types/agent`).

**Produces (Interfaces):**

```ts
export interface InheritSource {
  childWorktree: string;
  parentLabel: string;
  parentWorktree: string;
}

/** The context note both tiers lead with when paths may be stale. */
export function pathMappingNote(source: InheritSource): string;

/**
 * Deterministic digest of a parent transcript. Sections, in order:
 * 任务目标 (first user-message), 近期结论 (up to the last 3 assistant texts,
 * most recent last, each clipped to 500 chars), 触碰过的文件 (unique
 * tool-started details that look like paths under the parent worktree,
 * rewritten repo-relative, capped at 20), 未决事项 (trailing error events
 * and permission-requests still pending at the end). Skips empty sections.
 * Returns "" when the transcript has no user-message at all.
 */
export function buildBrief(events: AgentEvent[], source: InheritSource): string;

/**
 * The parent's visible conversation as role/text pairs for codex
 * thread/inject_items: user-message events verbatim; assistant text
 * accumulated from text-delta events between turn-started and turn-done —
 * the turn-done EVENT carries no text; only the fold's item does — skipping
 * turns whose accumulated text is empty. Tool chatter, thinking and
 * permissions are deliberately not replayed.
 */
export function buildHistoryMessages(
  events: AgentEvent[]
): { role: "assistant" | "user"; text: string }[];
```

**Step 1: Write the failing test**

`src/tests/unit/agent-inherit.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  buildBrief,
  buildHistoryMessages,
  pathMappingNote,
} from "@/lib/agent/inherit";
import type { AgentEvent } from "@/types/agent";

const SOURCE = {
  childWorktree: "/repo.worktrees/feat-child",
  parentLabel: "feat/parent",
  parentWorktree: "/repo.worktrees/feat-parent",
};

function transcript(): AgentEvent[] {
  return [
    { kind: "user-message", text: "Add retry logic to the sync engine." },
    { kind: "turn-started", turnId: "t1" },
    {
      detail: "/repo.worktrees/feat-parent/src/sync/engine.ts",
      kind: "tool-started",
      name: "Read",
      toolId: "tu1",
    },
    { detail: "", kind: "tool-finished", ok: true, toolId: "tu1" },
    {
      detail: "npm test",
      kind: "tool-started",
      name: "Bash",
      toolId: "tu2",
    },
    { detail: "", kind: "tool-finished", ok: true, toolId: "tu2" },
    {
      kind: "text-delta",
      text: "Added exponential backoff in engine.ts; ",
    },
    { kind: "text-delta", text: "tests pass." },
    {
      costUsd: 0.1,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "t1",
      usage: null,
    },
    { kind: "user-message", text: "Now cap retries at five." },
    { kind: "turn-started", turnId: "t2" },
    {
      kind: "error",
      message: "The agent stream failed.",
    },
    {
      costUsd: null,
      kind: "turn-done",
      stopReason: "error",
      turnId: "t2",
      usage: null,
    },
  ];
}

describe("buildBrief", () => {
  test("digests goal, decisions, repo-relative files and open items", () => {
    const brief = buildBrief(transcript(), SOURCE);
    expect(brief).toContain("Add retry logic to the sync engine.");
    expect(brief).toContain("Added exponential backoff in engine.ts");
    expect(brief).toContain("src/sync/engine.ts");
    expect(brief).not.toContain("/repo.worktrees/feat-parent/src");
    expect(brief).toContain("The agent stream failed.");
    expect(brief).toContain("feat/parent");
  });

  test("a transcript with no user message digests to nothing", () => {
    expect(
      buildBrief([{ kind: "turn-started", turnId: "t1" }], SOURCE)
    ).toBe("");
  });
});

describe("buildHistoryMessages", () => {
  test("keeps user and non-empty assistant texts in order, drops the rest", () => {
    expect(buildHistoryMessages(transcript())).toEqual([
      { role: "user", text: "Add retry logic to the sync engine." },
      {
        role: "assistant",
        text: "Added exponential backoff in engine.ts; tests pass.",
      },
      { role: "user", text: "Now cap retries at five." },
    ]);
  });
});

describe("pathMappingNote", () => {
  test("names both roots so the agent can map stale paths", () => {
    const note = pathMappingNote(SOURCE);
    expect(note).toContain("/repo.worktrees/feat-parent");
    expect(note).toContain("/repo.worktrees/feat-child");
  });
});
```

**Step 2:** run it, confirm module-not-found failure.

**Step 3: Implement** `src/lib/agent/inherit.ts` — pure functions matching the
tests. Assistant text is accumulated from `text-delta` events per turn (the
`turn-done` EVENT carries no text — increment 1's fold builds item text the
same way); tool paths are `tool-started` details that start with
`${parentWorktree}/`; rewrite = strip that prefix. Brief format is markdown
with a heading naming the parent label and the four sections; lead with
`pathMappingNote` only in the FULL tier (the manager adds it there — the brief
tier's rewrite makes it unnecessary, keep the brief self-contained without it).

**Step 4:** green, full gates.

**Step 5: Commit** `"Digest a parent conversation into an inheritable brief"`

---

## Task 2: Pending-inheritance persistence and the registry record

**Files:**
- Create: `src/ipc/agent/inheritance.ts`
- Modify: `src/ipc/agent/registry.ts` (schema gains optional `inherited`)
- Create: `src/tests/unit/agent-inheritance-store.test.ts`

**Produces (Interfaces):**

```ts
// registry.ts — worktreeAgentStateSchema gains:
inherited: z
  .object({
    at: z.number(),
    from: z.string(),
    mode: z.enum(["brief", "full"]),
    // The human-facing provenance label. The path in `from` is machine
    // identity; a root parent's path tail is the folder name, not "main".
    parentLabel: z.string(),
  })
  .optional(),

// inheritance.ts — pending payload written at child-creation time and
// consumed exactly once by the child's first send. Lives beside transcripts:
// <baseDir>/inherit-<worktreeHash(childWorktree)>.json, atomic tmp+rename.
export interface PendingInheritance {
  brief?: string;
  history?: { role: "assistant" | "user"; text: string }[];
  mode: "brief" | "full";
  note: string;
  parentSessionId?: string; // cc full tier: fork source
  parentWorktree: string;
}
export function writePendingInheritance(
  baseDir: string,
  childWorktree: string,
  pending: PendingInheritance
): Promise<void>;
export function readPendingInheritance(
  baseDir: string,
  childWorktree: string
): Promise<PendingInheritance | null>; // null on missing OR unparseable
export function clearPendingInheritance(
  baseDir: string,
  childWorktree: string
): Promise<void>; // idempotent
```

Tests: round-trip; missing → null; corrupt file → null and left in place;
clear is idempotent; registry schema accepts an entry with and without
`inherited` (both directions of `loadRegistry`/`saveRegistry`).

**Commit** `"Persist a child's pending inheritance beside the transcripts"`

---

## Task 3: Manager — prepare, consume-on-first-send, badge metadata

**Files:**
- Modify: `src/ipc/agent/manager.ts`
- Modify: `src/ipc/agent/driver.ts` (`StartTurnInput.resume` gains
  `fork?: boolean`; new optional `inject?: { role; text }[]`)
- Modify: `src/tests/unit/agent-manager.test.ts` (+3 tests)

**Behavior contract:**

1. `export async function prepareInheritance(input: { childWorktree: string; mode: "brief" | "full"; parentLabel: string; parentWorktree: string }): Promise<{ ok: boolean; reason?: string }>` —
   reads the parent transcript (`readTranscript`); empty/no-user-message
   parent → `{ ok: false, reason: "The parent has no conversation to inherit." }`
   and writes nothing. Otherwise builds via Task 1's lib:
   - brief mode: `{ mode, brief, note, parentWorktree }`
   - full mode: `{ mode, history, note, parentWorktree, parentSessionId }`
     (parentSessionId from the parent's registry entry when its driver is
     claude-code; may be undefined)
   Writes the pending file, then updates the child's registry entry:
   config copied from the PARENT's entry (driver + tier follow the parent so
   the fork lands on the same vendor), plus
   `inherited: { at: Date.now(), from: parentWorktree, mode, parentLabel: input.parentLabel }`
   — the label is persisted so the badge never has to reverse-engineer a
   branch name from a worktree path (amended after Task 6's review: a root
   parent's path tail is the repo folder, not its branch).
2. `send()` — after the reservation, before building `StartTurnInput`: read
   pending inheritance for this worktree. If present:
   - brief: prompt becomes `` `${pending.brief}\n\n---\n\n${trimmed}` ``.
   - full + entry.driverId === "claude-code" && pending.parentSessionId:
     resume = `{ fork: true, sessionId: pending.parentSessionId, threadId: null }`.
   - full + codex (or cc without a parentSessionId): prompt = trimmed,
     `inject = [{ role: "user", text: pending.note }, ...pending.history]`.
   Clear the pending file only AFTER `driver.startTurn` was reached (the
   failed-start catch must leave it intact for a retry).
3. `getConfig()` return gains `inherited` (the registry record or null) so
   the UI badge can render.

Tests (puppet-driven, fake timers, tmp baseDir as today):
- prepare(brief) then first send: puppet's received `input.prompt` starts
  with the brief and ends with the user's text; pending file gone after the
  turn started; registry has `inherited.mode === "brief"`.
- prepare(full) with a parent registry entry carrying sessionId `parent-s1`
  (driver claude-code): puppet receives `resume: { fork: true, sessionId: "parent-s1", ... }`
  and an unmodified prompt.
- prepare on an empty parent transcript refuses; nothing written.

**Commit** `"Prepare and consume conversation inheritance in the manager"`

---

## Task 4: Adapters — fork flag and codex inject_items

**Files:**
- Modify: `src/ipc/claude/options.ts` (+ `forkSession: true` when
  `input.resume.fork` and a resume id is set)
- Modify: `src/ipc/codex/adapter.ts` (after thread/start on a FRESH thread,
  if `input.inject?.length`, one `thread/inject_items` request with
  `{ items: inject.map(m => ({ content: [{ text: m.text, type: m.role === "user" ? "input_text" : "output_text" }], role: m.role, type: "message" })), threadId }`;
  never on thread/resume — a resumed thread already holds its history)
- Modify: `src/tests/unit/claude-options.test.ts` (+1),
  `src/tests/unit/codex-adapter.test.ts` (+1, scriptedChild records
  inject_items and acks it)

**Commit** `"Fork claude sessions and inject codex history for inherited turns"`

---

## Task 5: oRPC surface and renderer actions

**Files:**
- Modify: `src/ipc/agent/handlers.ts` + `src/ipc/agent/index.ts`
  (`prepareInheritance` procedure: input `{ childWorktree, mode, parentLabel, parentWorktree }`,
  output `{ ok, reason? }`; `getConfig`'s output schema gains `inherited`)
- Modify: `src/actions/agent.ts` (wrapper `prepareAgentInheritance`)
- Modify: `src/tests/unit/agent-handlers.test.ts` (+1 routing test)

**Commit** `"Expose inheritance preparation over oRPC"`

---

## Task 6: Creation UI — the inheritance control and the badge

**Files:**
- Modify: `src/components/canvas/branch-node.tsx` (`BranchNameEditor` draft
  card gains a compact three-way control: 无 / 简报 / 完整历史 — default 简报,
  rendered only when the parent session `hasConversation`; selection returned
  through `onCommit(name, inherit)`)
- Modify: `src/components/canvas/branch-canvas.tsx` (`commitDraft` threads
  `inherit`), `src/stores/repo-store.ts` (`createBranch(folder, startPoint, name, inherit?)`:
  after `createWorktree` succeeds and before selecting, when
  `inherit && inherit.mode !== "none"` call `prepareAgentInheritance({ childWorktree: worktreePath, mode: inherit.mode, parentLabel: inherit.parentLabel, parentWorktree: inherit.parentWorktree })`
  — failures surface via the store's existing error channel but do NOT undo
  the creation)
- Modify: `src/components/panel/agent-tab.tsx` (conversation header renders
  `inherited from <parent> (<mode>)` from `getConfig`'s new field — a quiet
  one-line badge above the first item)
- Modify/create tests: `src/tests/unit/agent-tab.test.tsx` (+1 badge test),
  `src/tests/unit/branch-create-inherit.test.tsx` (control renders only with
  a conversation; default 简报; selection reaches createBranch)

**Commit** `"Offer inheritance at branch creation and badge inherited chats"`

---

## Task 7: Gates, controller smoke, atlas note

- Full gates: `npx vitest run` ×2, `npx tsc --noEmit --skipLibCheck`,
  `npm run check` (touched files), `npm run package`.
- Controller smoke (NOT the implementer): real cc, brief tier — parent
  worktree conversation plants a fact, create child with brief, child's first
  turn asks "what is this branch's task?" and must answer from the brief
  without being told (spec §6 DoD). Full tier: fork smoke re-uses the banked
  spike shape against the manager.
- Atlas: append a MEAS row (`claude --resume --fork-session works across
  cwd, verified`) and mark the A-lane/W2-adjacent landed state in the WORK
  array `status` fields touched by increments 1–2. Small, surgical edits.

**Commit** `"Close increment 2: gates, smoke, atlas"` (atlas edit may ride in
this commit; smoke results go to the ledger, not the repo).
