import path from "node:path";
import { EventQueue } from "@/lib/queue";
import type { AgentConfig, AgentDriverId, AgentEvent } from "@/types/agent";
import type { AgentDriver, AgentTurnHandle } from "./driver";
import { type AgentRegistry, loadRegistry, saveRegistry } from "./registry";
import { appendTranscript, readTranscript } from "./transcript";

const FLUSH_MS = 50;
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

interface ActiveTurn {
  flushed: AgentEvent[]; // replay buffer for late attachers, this turn only
  handle: AgentTurnHandle;
  /**
   * Delta runs in arrival order — only ADJACENT same-kind runs merge, so a
   * thinking→text transition can never flush inverted.
   */
  pendingDeltas: Extract<
    AgentEvent,
    { kind: "text-delta" | "thinking-delta" }
  >[];
  timer: NodeJS.Timeout | null;
}

/**
 * Occupies a worktree's slot between the synchronous guard in `send()` and
 * `startTurn` resolving. Never iterated, never mutated — see `send()`.
 */
const RESERVED_TURN: ActiveTurn = {
  flushed: [],
  handle: {
    events: (async function* (): AsyncGenerator<AgentEvent> {
      // Placeholder only; nothing ever iterates the reservation's handle.
    })(),
    interrupt: () => Promise.resolve(),
  },
  pendingDeltas: [],
  timer: null,
};

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
let shuttingDown = false;

/**
 * Per-worktree emit chain: transcript appends and broadcasts happen strictly
 * in event order, even though each append awaits the filesystem. Without
 * this, a delta flush timer racing a non-delta emit (or two flush timers
 * racing each other) could let events land out of order.
 */
const emitChains = new Map<string, Promise<void>>();
function enqueueEmit(worktreePath: string, event: AgentEvent): Promise<void> {
  const tail = emitChains.get(worktreePath) ?? Promise.resolve();
  const next = tail.then(() => emit(worktreePath, event));
  emitChains.set(
    worktreePath,
    next.catch(() => undefined)
  );
  return next;
}

/**
 * Serializes every read-modify-write of registry.json (Task 2 carry-over):
 * the manager is the file's only writer, but setConfig / persistIds / send
 * can all overlap, and saveRegistry's fixed `.tmp` name means two concurrent
 * load-modify-save cycles can race — the second save can lose the first's
 * update, or even fail outright (rename of a `.tmp` the other call already
 * consumed). Chaining every mutation onto this promise turns "load, mutate,
 * save" into one atomic step relative to every other mutation.
 */
let registryQueue: Promise<void> = Promise.resolve();

async function updateRegistry<T>(
  mutate: (registry: AgentRegistry) => T
): Promise<T> {
  const dir = await baseDir();
  let result!: T;
  const run = registryQueue.then(async () => {
    const registry = await loadRegistry(dir);
    result = mutate(registry);
    await saveRegistry(dir, registry);
  });
  // Keep the chain alive even if this mutation throws, so a later caller
  // is not stuck waiting on a permanently-rejected promise.
  registryQueue = run.then(
    () => undefined,
    () => undefined
  );
  await run;
  return result;
}

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
  emitChains.clear();
  state.baseDir = null;
  state.drivers = {};
  registryQueue = Promise.resolve();
  shuttingDown = false;
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
      onSpawn: (pid) =>
        import("./pids")
          .then(({ registerPid }) => registerPid(dir, pid))
          .catch(() => undefined),
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
  // before broadcasting so anything a subscriber has seen is already
  // history — readHistory() can never come up short on an event a live
  // listener just received.
  const turn = turns.get(worktreePath);
  await appendTranscript(await baseDir(), worktreePath, event);
  turn?.flushed.push(event);
  broadcast(worktreePath, event);
}

/**
 * Extends the turn's last pending run if it shares the new delta's kind,
 * otherwise starts a new run — see `ActiveTurn.pendingDeltas` for why arrival
 * order, not kind, decides how runs are grouped.
 */
function pushDelta(
  turn: ActiveTurn,
  event: Extract<AgentEvent, { kind: "text-delta" | "thinking-delta" }>
): void {
  const lastRun = turn.pendingDeltas.at(-1);
  if (lastRun && lastRun.kind === event.kind) {
    lastRun.text += event.text;
  } else {
    turn.pendingDeltas.push(event);
  }
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
    last = enqueueEmit(worktreePath, run);
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
    flushDeltas(worktreePath);
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
  await updateRegistry((registry) => {
    const entry = registry.worktrees[worktreePath];
    registry.worktrees[worktreePath] = {
      driverId: config.driverId,
      sessionId: entry?.sessionId ?? null,
      threadId: entry?.threadId ?? null,
      tier: config.tier,
      updatedAt: Date.now(),
    };
    registry.lastDriverId = config.driverId;
  });
}

async function persistIds(
  worktreePath: string,
  ids: { sessionId?: string; threadId?: string }
): Promise<void> {
  await updateRegistry((registry) => {
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
  });
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
    const resume = {
      sessionId: entry?.sessionId ?? null,
      threadId: entry?.threadId ?? null,
    };

    const driver = await driverFor(config.driverId);
    handle = driver.startTurn({
      onSessionId: (id) => persistIds(worktreePath, { sessionId: id }),
      onThreadId: (id) => persistIds(worktreePath, { threadId: id }),
      prompt: trimmed,
      requestPermission: (request) =>
        new Promise<boolean>((resolve) => {
          const forWorktree = pendingPermissions.get(worktreePath) ?? new Map();
          pendingPermissions.set(worktreePath, forWorktree);
          // The manager owns the permission EVENTS for both vendors: the
          // Claude SDK's callback cannot yield into its adapter's stream at
          // all, and every settle path (answer, timeout, interrupt, crash)
          // funnels through here — so this is the one place the request and
          // its resolution reliably reach the transcript and the UI. Fire
          // and forget with a catch: nothing here can `await` from inside a
          // Promise executor or a timer callback.
          enqueueEmit(worktreePath, {
            detail: request.detail,
            kind: "permission-request",
            requestId: request.requestId,
            toolName: request.toolName,
          }).catch(() => undefined);
          const settle = (approved: boolean): void => {
            resolve(approved);
            enqueueEmit(worktreePath, {
              approved,
              kind: "permission-resolved",
              requestId: request.requestId,
            }).catch(() => undefined);
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

  (async () => {
    try {
      for await (const event of handle.events) {
        const live = turns.get(worktreePath);
        if (live !== turn) {
          return; // superseded (shutdown raced a stream tail)
        }
        if (event.kind === "text-delta" || event.kind === "thinking-delta") {
          pushDelta(turn, event);
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
      // Backstop: a stream that ends without a terminal event, and the
      // crash/error path above, both free the slot; no parked permission
      // waits out its five minutes against a dead turn.
      if (turns.get(worktreePath) === turn) {
        turns.delete(worktreePath);
      }
      denyPendingPermissions(worktreePath);
    }
  })();

  return { accepted: true };
}

/**
 * Denies (resolves false) every permission still parked for a worktree and
 * clears their timers. Task 8 carry-over: a codex crash mid-turn — or any
 * interrupt, shutdown, or stream-error — must not leave `requestPermission`'s
 * promise waiting out the full 5-minute timeout once the turn it belonged to
 * is dead. Shared by the pump's `finally`, `interruptTurn`, and
 * `shutdownAgents`.
 */
function denyPendingPermissions(worktreePath: string): void {
  const forWorktree = pendingPermissions.get(worktreePath);
  if (!forWorktree) {
    return;
  }
  for (const entry of forWorktree.values()) {
    clearTimeout(entry.timer);
    entry.resolve(false);
  }
  pendingPermissions.delete(worktreePath);
}

/** Adjacent text/thinking deltas merge; every other event kind stands alone. */
function mergeAgentEvents(
  left: AgentEvent,
  right: AgentEvent
): AgentEvent | null {
  if (left.kind === "text-delta" && right.kind === "text-delta") {
    return { kind: "text-delta", text: left.text + right.text };
  }
  if (left.kind === "thinking-delta" && right.kind === "thinking-delta") {
    return { kind: "thinking-delta", text: left.text + right.text };
  }
  return null;
}

export function attachAgent(worktreePath: string): {
  queue: EventQueue<AgentEvent>;
  replay: AgentEvent[];
} {
  const queue = new EventQueue<AgentEvent>({ merge: mergeAgentEvents });
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
  // Also covers a turn that already died (e.g. a driver crash) leaving a
  // permission parked with no active turn left to answer it.
  denyPendingPermissions(worktreePath);
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

/**
 * Quit-time teardown: interrupt, shut drivers down, deny anything still
 * parked, then reap what's left.
 */
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
  // Belt and braces alongside interruptTurn's per-worktree deny above: a
  // worktree whose turn already ended (crash) before shutdown was even
  // called never goes through interruptTurn's loop, so sweep every worktree
  // here too rather than leaving its requestPermission promise parked.
  for (const worktreePath of [...pendingPermissions.keys()]) {
    denyPendingPermissions(worktreePath);
  }
  const { reapStrays } = await import("./pids");
  await reapStrays(await baseDir()).catch(() => []);
}
