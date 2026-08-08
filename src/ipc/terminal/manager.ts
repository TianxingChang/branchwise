import { existsSync } from "node:fs";
import type { IPty } from "node-pty";
import { EventQueue } from "@/lib/queue";
import { appendToScrollback } from "@/lib/terminal/buffer";
import type { TerminalEvent } from "@/types/terminal";

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

interface Session {
  buffer: string;
  cwd: string;
  exit: { exitCode: number; signal: number | null } | null;
  generation: number;
  pty: IPty;
}

const sessions = new Map<string, Session>();

/**
 * Subscriptions belong to the *terminal* — that is, to the worktree — not to
 * whichever shell process is currently serving it. Restarting swaps the process
 * underneath while the attached view keeps streaming.
 */
const subscribers = new Map<string, Set<EventQueue<TerminalEvent>>>();

/** Survives the session itself, so a restart can invalidate a pending spawn. */
const generations = new Map<string, number>();

function shellCommand(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "powershell.exe";
  }
  return process.env.SHELL || "/bin/zsh";
}

function nextGeneration(key: string): number {
  const generation = (generations.get(key) ?? 0) + 1;
  generations.set(key, generation);
  return generation;
}

function broadcast(key: string, event: TerminalEvent): void {
  const queues = subscribers.get(key);
  if (!queues) {
    return;
  }
  for (const queue of queues) {
    queue.push(event);
  }
}

export class TerminalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TerminalError";
  }
}

async function spawnSession(
  key: string,
  options: { columns: number; cwd: string; rows: number }
): Promise<Session> {
  if (!existsSync(options.cwd)) {
    throw new TerminalError(
      "This worktree's directory no longer exists on disk."
    );
  }

  const generation = nextGeneration(key);

  // node-pty is a native module kept out of the bundle, so it is loaded here
  // rather than at import time; a CJS native module can arrive under `default`.
  const imported = await import("node-pty");
  const pty = (imported.default ?? imported) as typeof import("node-pty");

  if (generations.get(key) !== generation) {
    throw new TerminalError("The terminal was restarted while starting up.");
  }

  let child: IPty;
  try {
    child = pty.spawn(shellCommand(), [], {
      cols: options.columns,
      cwd: options.cwd,
      env: { ...process.env, TERM: "xterm-256color" },
      name: "xterm-256color",
    });
  } catch (error) {
    throw new TerminalError(
      error instanceof Error
        ? `Could not start a shell: ${error.message}`
        : "Could not start a shell.",
      { cause: error }
    );
  }

  if (generations.get(key) !== generation) {
    child.kill();
    throw new TerminalError("The terminal was restarted while starting up.");
  }

  const session: Session = {
    buffer: "",
    cwd: options.cwd,
    exit: null,
    generation,
    pty: child,
  };
  sessions.set(key, session);

  // Every callback checks it is still the live session: a shell killed for a
  // restart can emit its final bytes after its replacement is already running.
  child.onData((data) => {
    if (sessions.get(key) !== session) {
      return;
    }
    session.buffer = appendToScrollback(session.buffer, data);
    broadcast(key, { data, kind: "data" });
  });

  child.onExit(({ exitCode, signal }) => {
    if (sessions.get(key) !== session) {
      return;
    }
    session.exit = { exitCode, signal: signal ?? null };
    broadcast(key, { exitCode, kind: "exit", signal: signal ?? null });
  });

  child.resize(options.columns, options.rows);
  return session;
}

/**
 * Returns the live session for a worktree, starting one if needed.
 *
 * Sessions outlive the component that shows them: switching the panel to Diff
 * and back must not kill a running dev server.
 */
export async function ensureSession(
  key: string,
  options: { columns?: number; cwd: string; rows?: number }
): Promise<void> {
  const existing = sessions.get(key);
  if (existing && existing.exit === null) {
    return;
  }
  if (existing) {
    sessions.delete(key);
  }

  await spawnSession(key, {
    columns: options.columns ?? DEFAULT_COLUMNS,
    cwd: options.cwd,
    rows: options.rows ?? DEFAULT_ROWS,
  });
}

export function subscribe(key: string): EventQueue<TerminalEvent> {
  const queue = new EventQueue<TerminalEvent>({
    // Adjacent output merges; an exit event never merges into anything.
    merge: (left, right) =>
      left.kind === "data" && right.kind === "data"
        ? { data: left.data + right.data, kind: "data" }
        : null,
  });

  const existing = subscribers.get(key) ?? new Set<EventQueue<TerminalEvent>>();
  existing.add(queue);
  subscribers.set(key, existing);
  return queue;
}

export function unsubscribe(
  key: string,
  queue: EventQueue<TerminalEvent>
): void {
  const queues = subscribers.get(key);
  queues?.delete(queue);
  if (queues && queues.size === 0) {
    subscribers.delete(key);
  }
  queue.close();
}

/** What an attaching view needs to catch up: scrollback, then any exit. */
export function snapshotOf(key: string): TerminalEvent[] {
  const session = sessions.get(key);
  if (!session) {
    return [];
  }

  const events: TerminalEvent[] = [];
  if (session.buffer.length > 0) {
    events.push({ data: session.buffer, kind: "data" });
  }
  if (session.exit) {
    events.push({
      exitCode: session.exit.exitCode,
      kind: "exit",
      signal: session.exit.signal,
    });
  }
  return events;
}

export function writeTo(key: string, data: string): boolean {
  const session = sessions.get(key);
  if (!session || session.exit !== null) {
    return false;
  }
  session.pty.write(data);
  return true;
}

export function resize(key: string, columns: number, rows: number): boolean {
  const session = sessions.get(key);
  if (!session || session.exit !== null) {
    return false;
  }
  session.pty.resize(Math.max(2, columns), Math.max(1, rows));
  return true;
}

/** Stops the shell. Attached views stay attached, ready for a restart. */
export function kill(key: string): void {
  nextGeneration(key);
  const session = sessions.get(key);
  if (!session) {
    return;
  }
  sessions.delete(key);
  try {
    session.pty.kill();
  } catch {
    // Already gone; nothing to clean up.
  }
}

export async function restart(
  key: string,
  options: { columns?: number; cwd: string; rows?: number }
): Promise<void> {
  kill(key);
  await spawnSession(key, {
    columns: options.columns ?? DEFAULT_COLUMNS,
    cwd: options.cwd,
    rows: options.rows ?? DEFAULT_ROWS,
  });
}

/** Ends a terminal for good, including any view still attached to it. */
function destroy(key: string): void {
  kill(key);
  for (const queue of subscribers.get(key) ?? []) {
    queue.close();
  }
  subscribers.delete(key);
}

/** Stops every session whose worktree lives under a directory. */
export function killUnder(prefix: string): void {
  for (const key of [...sessions.keys(), ...subscribers.keys()]) {
    if (key === prefix || key.startsWith(`${prefix}/`)) {
      destroy(key);
    }
  }
}

export function killAll(): void {
  for (const key of [...sessions.keys(), ...subscribers.keys()]) {
    destroy(key);
  }
}

export function isRunning(key: string): boolean {
  const session = sessions.get(key);
  return session !== undefined && session.exit === null;
}
