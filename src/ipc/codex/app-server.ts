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
      // Server→client request: first handler that answers wins. A handler
      // that throws synchronously must become an error reply, not an
      // exception escaping the stream's data listener.
      const [handler] = [...this.requestHandlers];
      let outcome: Promise<unknown>;
      try {
        outcome = Promise.resolve(
          handler ? handler(message.method, message.params) : undefined
        );
      } catch (error) {
        outcome = Promise.reject(error);
      }
      outcome
        .then((result) => this.send({ id: message.id as number, result }))
        .catch((error: unknown) =>
          this.send({
            error: {
              code: -32_000,
              message: error instanceof Error ? error.message : "failed",
            },
            id: message.id as number,
          })
        );
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
}
