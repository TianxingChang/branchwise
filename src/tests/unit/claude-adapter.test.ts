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
});
