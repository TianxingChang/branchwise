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

function extractRequestDetail(
  p: Record<string, unknown>,
  method: string
): string {
  return clip(p.command) || clip(p.path) || clip(p.reason) || method;
}

export function createCodexDriver(dependencies?: {
  client?: CodexAppServer;
  /** Called with the app-server child's pid the moment it is spawned. */
  onSpawn?: (pid: number) => void;
  resolveExecutable?: () => Promise<string | null>;
}): AgentDriver {
  let client: CodexAppServer | null = dependencies?.client ?? null;
  const resolve =
    dependencies?.resolveExecutable ?? (() => resolveCodexExecutable());
  const onSpawn = dependencies?.onSpawn;
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
        onSpawn?.(child.pid);
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

    async function initializeThread(server: CodexAppServer): Promise<string> {
      const known = input.resume.threadId ?? threads.get(input.worktreePath);
      const tierConfig = TIER_TO_THREAD[input.tier];
      if (known) {
        try {
          await server.request("thread/resume", { threadId: known });
          return known;
        } catch {
          // Fall through to start new thread
        }
      }
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
      return threadId;
    }

    async function initializeTurn(
      server: CodexAppServer,
      threadId: string
    ): Promise<string | null> {
      const turnStarted = rec(
        await server.request("turn/start", {
          cwd: input.worktreePath,
          input: [{ text: input.prompt, type: "text" }],
          threadId,
        })
      );
      return typeof turnStarted?.turnId === "string"
        ? turnStarted.turnId
        : null;
    }

    async function handleApprovalRequest(
      method: string,
      params: unknown,
      push: (e: AgentEvent) => void
    ): Promise<{ decision: "accept" | "decline" } | undefined> {
      if (!APPROVAL_METHODS.has(method)) {
        return; // not ours — let another handler claim it
      }
      const p = rec(params) ?? {};
      if (typeof p.threadId === "string" && p.threadId !== liveThreadId) {
        return; // another turn's thread — its handler claims it
      }
      const requestId = String(
        p.itemId ?? p.approvalId ?? p.call_id ?? randomUUID()
      );
      const detail = extractRequestDetail(p, method);
      push({ detail, kind: "permission-request", requestId, toolName: method });
      const approved = await input.requestPermission({
        detail,
        requestId,
        toolName: method,
      });
      push({ approved, kind: "permission-resolved", requestId });
      return { decision: approved ? "accept" : "decline" };
    }

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This is the main event generator; splitting further would hurt readability.
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

      const offRequest = server.onRequest((method, params) =>
        handleApprovalRequest(method, params, push)
      );

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

      try {
        liveThreadId = await initializeThread(server);
        threads.set(input.worktreePath, liveThreadId);
        input.onThreadId(liveThreadId);

        liveTurnId = await initializeTurn(server, liveThreadId);
        if (interrupted && liveThreadId && liveTurnId) {
          // Interrupt arrived while the ack was in flight: deliver it now
          // instead of silently dropping it.
          server
            .request("turn/interrupt", {
              threadId: liveThreadId,
              turnId: liveTurnId,
            })
            .catch(() => {
              // Ignore interrupt failures; client may be gone or turn already finished.
            });
        }

        // Drain buffered events while waiting for turn-done.
        // Keep yielding until both finished and queue is empty.
        // biome-ignore lint: Loop exits when finished flag is set.
        while (true) {
          const next = queue.shift();
          if (next) {
            yield next;
          } else if (finished) {
            break;
          } else {
            // Wait for event callback to push to queue.
            // biome-ignore lint: Intentional wait for event queue.
            await new Promise<void>((resolveWake) => {
              wake = resolveWake;
            });
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
            .catch(() => {
              // Ignore interrupt failures; client may be gone or turn already finished.
            });
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
