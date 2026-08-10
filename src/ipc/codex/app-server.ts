import { type SpawnOptionsWithStdioTuple, spawn } from "node:child_process";
import { AgentDriverError } from "@/ipc/agent/driver";
import { sanitizedEnvironment } from "@/ipc/agent/env";

export interface ChildStdio {
  kill: (signal?: NodeJS.Signals) => void;
  onExit: (cb: () => void) => void;
  pid: number | undefined;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
}

type CodexSpawnOptions = SpawnOptionsWithStdioTuple<"pipe", "pipe", "pipe">;

/**
 * Pure so the spawn contract is unit-testable without touching a real
 * process or mutating global env: detached mode, stdio wiring and the
 * sanitized env are decided here and nowhere else. Same sanitized env as
 * the claude spawn: an inherited GIT_DIR would retarget every git operation
 * codex performs at the wrong repository regardless of cwd. The explicit
 * stdio-tuple type (rather than the general SpawnOptions) keeps `spawn`'s
 * return narrowed to non-null stdin/stdout, which ChildStdio below relies
 * on.
 */
export function buildCodexSpawnOptions(
  env: NodeJS.ProcessEnv = process.env
): CodexSpawnOptions {
  return {
    detached: true,
    env: sanitizedEnvironment(env),
    stdio: ["pipe", "pipe", "pipe"],
  };
}

export function spawnCodexAppServer(executable: string): ChildStdio {
  // Its own process group so quit-time cleanup can kill the whole tree.
  const child = spawn(
    executable,
    ["app-server", "--stdio"],
    buildCodexSpawnOptions()
  );
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

  onNotification(
    handler: (method: string, params: unknown) => void
  ): () => void {
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
    // biome-ignore lint/suspicious/noUnnecessaryConditions: biome mis-narrows here; tsc requires the check.
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
    // biome-ignore lint/suspicious/noUnnecessaryConditions: biome mis-narrows here; tsc requires the check.
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
        Promise.resolve().then(() => {
          // biome-ignore lint/suspicious/noNestedPromises: the double microtask hop is required — responses settling in the same stdout chunk must beat request dispatch (verified empirically; see task-8 fix report).
          this.dispatchRequest(message).catch(() => {
            // Dispatch errors are already handled and sent as error replies
          });
        });
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

  private async dispatchRequest(
    message: Record<string, unknown>
  ): Promise<void> {
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
