# branchwise — agent runtime (Claude Code + Codex) and worktree context inheritance

Design, 2026-08-09. Two increments: (1) real agent conversations in the node
panel, dual-backend; (2) conversation-context inheritance when a child worktree
is created. Aligned with the atlas A-lane (A1/A2 plus slices of A3/A4/A6);
reference implementation studied: Dotwise-canvas.

---

## Verified premises

Checked against the binaries and the reference codebase on 2026-08-09, not taken
from memory.

1. This machine: `claude` 2.1.226 at `~/.local/bin/claude`, `codex-cli` 0.136.0
   via nvm. Both logged in.
2. `claude --help` confirms: `--resume <id>`, `--fork-session` ("when resuming,
   create a new session ID"), `--session-id <uuid>`, `--print
   --output-format stream-json`, `--include-partial-messages`,
   `--permission-mode`, `--no-session-persistence`.
3. `codex exec --help` confirms: `--json` (JSONL events), `exec resume
   <SESSION_ID> [PROMPT]` (+ `--last`), `-C/--cd <DIR>`, `--sandbox
   read-only|workspace-write|danger-full-access`, `--ephemeral`. **No fork
   primitive.**
4. Dotwise-canvas (`../../Dotwise-canvas`) runs both vendors in production
   behind an `AgentDriver` interface: Claude via `@anthropic-ai/claude-agent-sdk`
   `query()` (pinned exactly, `pathToClaudeCodeExecutable` can point at a
   user-installed CLI), Codex via a long-lived `codex app-server --stdio`
   JSON-RPC/JSONL child (319-line client, `thread/start` → `turn/start`,
   history replay via `thread/inject_items`, `turn/interrupt`, approval
   requests routed to the client). Its event union, JSONL client and event
   adapters are portable; its **permission posture is not** — canvas disables
   every native tool (`disallowedTools`, `permissionMode: "dontAsk"`,
   `approvalPolicy: "never"`) because its agents only call canvas business
   tools. branchwise agents exist to edit files in worktrees.
5. Canvas persists transcripts into the project directory
   (`<project>/dotwise/conversations/`). branchwise's ADR (settled) forbids
   this: transcripts go to application support, never the repo.
6. Claude sessions persist as JSONL under `~/.claude/projects/<munged-cwd>/`,
   keyed by the directory the CLI ran in. Whether `resume + forkSession`
   works when the child's cwd differs from the parent's is **unverified — a
   spike**, with a proven fallback (transcript inlined into the first prompt,
   canvas's `buildClaudeConversationPrompt` technique).
7. The oRPC `eventIterator` over MessagePort already streams the repo watcher
   and the Terminal tab's PTY in this codebase; the terminal manager
   (subscribe → replay scrollback → live) is the local precedent for
   long-lived, renderer-detachable streams. The atlas S1 abuse spike (abort,
   reload, backpressure) is still open and is inherited as a prerequisite
   here rather than re-litigated.

## Decisions (grilled 2026-08-09, all approved)

| # | Decision | Choice |
| --- | --- | --- |
| 1 | Definition of done for increment 1 | **Reliable foundation**: streaming chat + interrupt + per-worktree session persistence (resume across app restart) + clean child-process teardown + transcript rebuild without spawning. A2 complete plus minimal A3/A6 slices. |
| 2 | Credentials | **User-installed CLIs only.** Claude SDK pointed at the user's `claude` binary; user's `codex`. No bundled binaries, no stored keys, no BYOK. Detect-and-guide when missing. |
| 3 | Permission posture | Default **acceptEdits** (edits auto-approved, commands ask), per-node switch across four tiers including an explicit **yolo** tier with warning styling. Never default to bypass (atlas A5). |
| 4 | Inheritance semantics | **Both tiers**: structured handoff brief (default) and full-history carry (opt-in checkbox at branch creation). |
| 5 | Integration architecture | **Canvas-aligned**: Claude via agent SDK, Codex via app-server port — wrapped in branchwise's own `AgentEvent` vocabulary so the atlas A1 seam holds. Raw-CLI and ACP routes rejected (codex `exec` cannot route approvals; ACP adapters lose fork/cost fidelity). |

---

## §1 Boundary and vocabulary (atlas A1)

New main-process domains:

```
src/ipc/agent/    public surface: handlers, manager, driver SPI, registry, transcripts
src/ipc/claude/   Claude adapter (SDK types never leave this directory)
src/ipc/codex/    Codex adapter (app-server client + mapper, same rule)
src/types/agent.ts  zod schemas + inferred types shared with the renderer
```

`AgentEvent` union (branchwise's vocabulary — canvas's event set plus the cost
fields atlas A1 requires):

- `turn-started`
- `text-delta { text }`, `thinking-delta { text }`
- `tool-started { toolId, name, input }`, `tool-finished { toolId, output | error }`
- `permission-request { requestId, toolName, input }`
- `turn-done { costUsd?, usage?, stopReason }`
- `error { message }`

`AgentDriver` SPI: `{ id, capabilities, startTurn(input): AsyncIterable<AgentEvent>,
interrupt(), respondPermission(requestId, verdict), releaseSession() }`.

**Import boundary enforced**: `src/stores` and `src/components` must not import
vendor SDK types; a lint rule or a unit test over the import graph fails the
build if they do (A1 acceptance).

## §2 Session model in the main process

Key divergence from canvas: canvas's `stream()` call *is* the turn, so a
renderer reload kills the stream. branchwise turns run for minutes and must
survive reloads (atlas A3: "the renderer can be reloaded and must not take
agents with it"). Therefore the **terminal-manager shape**, not the canvas
shape:

- `AgentSessionManager` keyed by `worktreePath`: driver session handle, ring
  buffer of the active turn's events, subscriber queues.
- oRPC procedures: `attach(worktreePath)` → eventIterator (replay the active
  turn's events so far, then live — same discipline as terminal `attach`);
  `send(worktreePath, text)` → starts a turn, acks immediately, events flow to
  every attached subscriber; `interrupt`; `respondPermission`; `setConfig`
  (driverId + permission tier per node); `history(worktreePath)` → rebuilds the
  conversation from our transcript, **never spawns** (A6 rule); `releaseForWorktree`.
- **A4-lite from day one** (cheap now, expensive to retrofit): deltas coalesce
  on a ~50 ms tick in the manager — one IPC message per frame; the renderer
  store keeps streaming text in its own field and the items array grows only by
  whole messages. Full ring-buffer paging and the 20-node benchmark stay in A4.
- **A3 slice**: spawn into a process group; on `before-quit` interrupt active
  turns, SIGTERM, bounded ~2 s wait, SIGKILL, holding quit until done; a
  `pid + startTime` file in app support written on every spawn, scanned on
  launch to reap strays from a hard crash. Full three-way exit taxonomy
  (clean/crash/killed) and resume offers stay in A3.

Persistence (ADR settled: app support only, never the repo):

- `<userData>/agent/registry.json` — `worktreePath → { driverId, sessionId | threadId,
  permissionMode, inherited?, updatedAt }`, atomic write.
- `<userData>/agent/transcripts/<worktree-hash>.ndjson` — append-only event
  transcript (A6 slice); `worktree-hash` = short sha256 of the canonicalised
  worktree path; rebuild tolerates a partially written last line.

## §3 The two adapters

### Claude (`src/ipc/claude/`)

`@anthropic-ai/claude-agent-sdk`, **pinned exact** (canvas pins 0.3.222; pin
whatever current exact version passes the spike). Where canvas's config is the
opposite of ours:

| Option | canvas | branchwise |
| --- | --- | --- |
| binary | user CLI or bundled SDK binary | **user CLI only** (port `resolveUserClaudeExecutable`: `CLAUDE_BIN` → `~/.local/bin` → `~/.claude/local` → brew paths → `PATH`) |
| native tools | all disallowed | **all enabled** — editing the worktree is the product |
| cwd | workspace or app sandbox dir | **the worktree path**; env sanitised — strip `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`. The first test written asserts cwd + env (A2's own ordering) |
| permissionMode | `dontAsk` | four-tier mapping (table below); `canUseTool` callback → `permission-request` event → UI verdict |
| persistSession | `false` | **`true`** — sessions live in the user's own `~/.claude`; `session_id` captured from the init event the moment it arrives and persisted per worktree; resume via `resume` after restart. Side effect, stated openly: these sessions appear in the user's own `claude --resume` list. That is a feature, not a leak. |

Event adapter is a pure function with fixture tests (split-chunk boundaries
included). Canvas's `supersedes` reconciliation is not ported in v1.

### Codex (`src/ipc/codex/`)

Port canvas's `app-server-client.ts` (JSONL JSON-RPC, generation guard so a
dead process's late messages cannot leak into its successor, 30 s per-request
deadline — that deadline bounds request *acks* like `turn/start`, not the
minutes-long notification stream). One thread per worktree; `thread/start` with
`cwd` = worktree; approval requests (`applyPatchApproval`, `execCommandApproval`)
map to `permission-request` events and the verdict returns over JSON-RPC.

### Permission tiers (per node, persisted in the registry)

| Tier | Claude | Codex | Note |
| --- | --- | --- | --- |
| plan | `plan` | sandbox `read-only`, approval `on-request` | read-only exploration |
| ask-everything | `default` | approval `untrusted`, sandbox `workspace-write` | everything asks |
| **acceptEdits (default)** | `acceptEdits` | sandbox `workspace-write`, approval `on-request` | **asymmetry, stated honestly**: cc still asks for Bash; codex runs sandboxed commands without asking (the sandbox is the guard) |
| yolo | `bypassPermissions` | `danger-full-access`, approval `never` | explicit per-node switch, warning styling, never a default |

## §4 Renderer

- `agent-store.ts` rewritten (canned pool deleted): attach lifecycle bound to
  panel open/close; streaming buffer separate from committed items; permission
  requests render as cards in the conversation (approve / deny / approve-all-
  this-turn). Tray, node badges, dock counts stay in A5/A7.
- `agent-tab.tsx` rewritten: message list (user / assistant / collapsible
  thinking / tool cards / permission cards), streaming text, cost line (cc
  reports per-turn cost, codex reports usage; both labelled estimates),
  interrupt button. **Driver picker** per node before the first message
  (remembers last choice), locked once a conversation exists — switching
  backend means a new conversation. **Tier picker** with the four tiers, yolo
  visually distinct. Input disabled while a turn runs (codex steer and cc
  message queueing are out of scope).
- Agent output renders as untrusted content: plain text / restricted markdown,
  no raw HTML, no auto-executing links (atlas security edge).

## §5 Increment 2 — context inheritance

Branch-creation flow gains an inheritance control: `none / brief (default) /
full history (checkbox)`. Source is a snapshot of the parent node's
conversation at creation time. The registry records
`inherited: { from, mode, at }`; the child's conversation header shows an
"inherited from <parent> (brief)" badge.

- **Brief (default)** — deterministic digest generated from our own NDJSON
  transcript: task goal (first user message), recent decisions (last assistant
  messages), files touched (from tool events, **rewritten to repo-relative
  paths**), open items. Injected as a prefix to the child's first turn. Zero
  cost, zero latency, offline, identical across vendors. An LLM-refined brief
  is a listed future upgrade, not in this increment.
- **Full history (opt-in)** — codex: new thread in the child cwd +
  `thread/inject_items` replaying the parent's visible conversation (canvas-
  proven). cc: **spike first** — `resume + forkSession` across cwd (sessions
  are filed per project directory; expected to fail; half-day timebox). If it
  fails, fall back to inlining the parent transcript JSON into the first
  prompt (canvas-proven). Both vendors get a leading context note: "the
  working directory changed from <parent> to <child>; map any old absolute
  paths onto the new root." The stale-path risk of this tier was raised and
  accepted during review.

**Path-poisoning hazard, recorded**: a parent history is full of absolute
paths under the parent worktree; a child agent following them would edit the
parent's branch — the A2 wrong-branch bug arriving through context instead of
cwd. The brief tier avoids it structurally (repo-relative rewrite); the full
tier mitigates with the context note and carries residual risk by explicit
user choice.

## §6 Errors and testing

Error surfaces: CLI missing or logged out (detect, guide install, never
silent); spawn failure; mid-turn crash (transcript already on disk; offer
resume); approval timeout (5 minutes → treated as denial, noted in the
stream); real error text crosses oRPC via the repo domain's existing
`expose()` idiom.

Tests (atlas Gates 0–2; CI never runs a real agent):

1. **First test written**: child spawns with cwd = worktree and sanitised env
   (no `GIT_DIR`/`GIT_WORK_TREE`) — A2's ordering, verbatim.
2. Event adapters: fixture-driven pure-function tests for both vendors,
   including split chunks, out-of-order notifications, partial lines.
3. Manager: attach replays then goes live; reload re-attach does not duplicate
   subscriptions; interrupt mid-turn; quit kills the process group (fixture
   script that ignores SIGTERM); stray-pid reaping on launch.
4. Registry + transcript: restart rebuilds a mid-turn conversation from disk,
   including a torn final line; never spawns during rebuild.
5. Import-boundary test: no vendor type reachable from `src/stores` or
   `src/components`.

Definition of done for each increment: `npx tsc --noEmit --skipLibCheck`
clean, `npx vitest run` green, `npm run package` succeeds, demo criterion
holds (inc. 1: two nodes, two vendors, both streaming, quit leaves no
processes; inc. 2: child created with brief inherits and answers a question
about the parent's task without being told).

## §7 Explicitly out of scope

Full A4 (ring-buffer paging, 20-node benchmark), A5 tray and node badges, A7
attention model, codex steer, model pickers (vendor CLI defaults apply), BYOK
api-key mode, multiple conversations per node, mid-conversation backend
switching, LLM-refined briefs, ACP as a third adapter.
