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
  pendingText: string;
  pendingThinking: string;
  timer: NodeJS.Timeout | null;
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
  state.baseDir = null;
  state.drivers = {};
  registryQueue = Promise.resolve();
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
    state.drivers[id] = createCodexDriver();
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
  // Persist before making the event observable in memory: a subscriber that
  // sees this via broadcast() or a late attacher that sees it via `flushed`
  // must never be able to outrun readHistory() and find it missing from the
  // transcript it was just told about.
  await appendTranscript(await baseDir(), worktreePath, event);
  const turn = turns.get(worktreePath);
  turn?.flushed.push(event);
  broadcast(worktreePath, event);
}

function flushDeltas(worktreePath: string): Promise<void> {
  const turn = turns.get(worktreePath);
  if (!turn) {
    return Promise.resolve();
  }
  const writes: Promise<void>[] = [];
  if (turn.pendingText.length > 0) {
    writes.push(
      emit(worktreePath, { kind: "text-delta", text: turn.pendingText })
    );
    turn.pendingText = "";
  }
  if (turn.pendingThinking.length > 0) {
    writes.push(
      emit(worktreePath, { kind: "thinking-delta", text: turn.pendingThinking })
    );
    turn.pendingThinking = "";
  }
  if (turn.timer) {
    clearTimeout(turn.timer);
    turn.timer = null;
  }
  return Promise.all(writes).then(() => undefined);
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
  if (turns.has(worktreePath)) {
    return { accepted: false, reason: "A turn is already running." };
  }

  const dir = await baseDir();
  const registry = await loadRegistry(dir);
  const entry = registry.worktrees[worktreePath];
  const config: AgentConfig = entry
    ? { driverId: entry.driverId, tier: entry.tier }
    : { driverId: registry.lastDriverId, tier: "accept-edits" };
  if (!entry) {
    await setConfig(worktreePath, config);
  }

  const driver = await driverFor(config.driverId);
  const handle = driver.startTurn({
    onSessionId: (id) => persistIds(worktreePath, { sessionId: id }),
    onThreadId: (id) => persistIds(worktreePath, { threadId: id }),
    prompt: trimmed,
    requestPermission: (request) =>
      new Promise<boolean>((resolve) => {
        const forWorktree = pendingPermissions.get(worktreePath) ?? new Map();
        pendingPermissions.set(worktreePath, forWorktree);
        const timer = setTimeout(() => {
          forWorktree.delete(request.requestId);
          resolve(false);
        }, PERMISSION_TIMEOUT_MS);
        forWorktree.set(request.requestId, { resolve, timer });
      }),
    resume: {
      sessionId: entry?.sessionId ?? null,
      threadId: entry?.threadId ?? null,
    },
    tier: config.tier,
    worktreePath,
  });

  const turn: ActiveTurn = {
    flushed: [],
    handle,
    pendingText: "",
    pendingThinking: "",
    timer: null,
  };
  turns.set(worktreePath, turn);
  await emit(worktreePath, { kind: "user-message", text: trimmed });

  (async () => {
    try {
      for await (const event of handle.events) {
        const live = turns.get(worktreePath);
        if (live !== turn) {
          return; // superseded (shutdown raced a stream tail)
        }
        if (event.kind === "text-delta") {
          turn.pendingText += event.text;
          scheduleFlush(worktreePath);
          continue;
        }
        if (event.kind === "thinking-delta") {
          turn.pendingThinking += event.text;
          scheduleFlush(worktreePath);
          continue;
        }
        await flushDeltas(worktreePath);
        await emit(worktreePath, event);
        if (event.kind === "turn-done") {
          turns.delete(worktreePath);
        }
      }
    } catch (error) {
      await flushDeltas(worktreePath);
      await emit(worktreePath, {
        kind: "error",
        message:
          error instanceof Error ? error.message : "The agent stream failed.",
      });
      await emit(worktreePath, {
        costUsd: null,
        kind: "turn-done",
        stopReason: "error",
        turnId: "stream",
        usage: null,
      });
      turns.delete(worktreePath);
    }
  })();

  return { accepted: true };
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

/**
 * Denies (resolves false) every permission still parked for a worktree and
 * clears their timers. Task 8 carry-over: a codex crash mid-turn — or any
 * interrupt/shutdown — must not leave `requestPermission`'s promise waiting
 * out the full 5-minute timeout once the turn it belonged to is dead.
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

function denyAllPendingPermissions(): void {
  for (const worktreePath of [...pendingPermissions.keys()]) {
    denyPendingPermissions(worktreePath);
  }
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
  // worktree whose turn already ended (crash) before shutdown was called
  // never goes through interruptTurn's loop, so sweep every worktree here
  // too rather than leaving its requestPermission promise parked.
  denyAllPendingPermissions();
  const { reapStrays } = await import("./pids");
  await reapStrays(await baseDir()).catch(() => []);
}
