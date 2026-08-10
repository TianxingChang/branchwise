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

    /**
     * `fresh` distinguishes a brand-new thread/start from a resumed one —
     * only a fresh thread has no history of its own, and is therefore the
     * only one ever eligible for a history injection below.
     */
    async function initializeThread(
      server: CodexAppServer
    ): Promise<{ fresh: boolean; threadId: string }> {
      const known = input.resume.threadId ?? threads.get(input.worktreePath);
      const tierConfig = TIER_TO_THREAD[input.tier];
      if (known) {
        try {
          await server.request("thread/resume", { threadId: known });
          return { fresh: false, threadId: known };
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
      return { fresh: true, threadId };
    }

    /**
     * Seeds a freshly started thread with a parent conversation (full-tier
     * inheritance that fell back from a claude-code fork). Never called for
     * a resumed thread, which already holds its own history. A rejection
     * here is left to propagate to the caller's try/catch, same as any
     * other setup failure — the guarded lifecycle turns it into an error
     * event plus a terminal turn-done rather than a throw reaching the
     * consumer.
     */
    async function injectHistory(
      server: CodexAppServer,
      threadId: string
    ): Promise<void> {
      if (!input.inject?.length) {
        return;
      }
      await server.request("thread/inject_items", {
        items: input.inject.map((message) => ({
          content: [
            {
              text: message.text,
              type: message.role === "user" ? "input_text" : "output_text",
            },
          ],
          role: message.role,
          type: "message",
        })),
        threadId,
      });
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
      params: unknown
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
      // The manager emits the permission-request / permission-resolved
      // events for every vendor — pushing them here too would render each
      // approval card twice.
      const approved = await input.requestPermission({
        detail,
        requestId,
        toolName: method,
      });
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

      const offRequest = server.onRequest(handleApprovalRequest);

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
        const thread = await initializeThread(server);
        liveThreadId = thread.threadId;
        threads.set(input.worktreePath, liveThreadId);
        input.onThreadId(liveThreadId);

        if (thread.fresh) {
          await injectHistory(server, liveThreadId);
        }

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
