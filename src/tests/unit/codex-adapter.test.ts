import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { CodexAppServer, type ChildStdio } from "@/ipc/codex/app-server";
import { createCodexDriver } from "@/ipc/codex/adapter";
import type { StartTurnInput } from "@/ipc/agent/driver";
import type { AgentEvent } from "@/types/agent";

function scriptedChild(options: { withApproval: boolean }) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const received: Record<string, unknown>[] = [];
  let buffer = "";
  function send(message: Record<string, unknown>): void {
    stdout.write(`${JSON.stringify(message)}\n`);
  }
  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (line.trim().length === 0) {
        continue;
      }
      const message = JSON.parse(line) as Record<string, unknown>;
      received.push(message);
      if (message.method === "initialize") {
        send({ id: message.id, result: {} });
      }
      if (message.method === "thread/start") {
        send({ id: message.id, result: { threadId: "th_9" } });
      }
      if (message.method === "turn/start") {
        send({ id: message.id, result: { turnId: "turn_9" } });
        if (options.withApproval) {
          // Ask for approval before doing anything else; the wire round-trip
          // is what's under test, not the decision's effect.
          send({
            id: 77,
            method: "item/commandExecution/requestApproval",
            params: {
              command: "rm -rf build",
              itemId: "call_1",
              threadId: "th_9",
              turnId: "turn_9",
            },
          });
        }
        send({
          method: "item/agentMessage/delta",
          params: { delta: "done", threadId: "th_9" },
        });
        send({
          method: "turn/completed",
          params: { threadId: "th_9", turn: { status: "completed" } },
        });
      }
      if (message.method === "turn/interrupt") {
        send({ id: message.id, result: {} });
      }
    }
  });
  const child: ChildStdio = {
    kill: () => {},
    onExit: () => {},
    pid: 1,
    stdin,
    stdout,
  };
  return { child, received };
}

function baseInput(overrides: Partial<StartTurnInput> = {}): StartTurnInput {
  return {
    onSessionId: () => {},
    onThreadId: () => {},
    prompt: "go",
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

describe("codex adapter", () => {
  test("starts a thread with the worktree cwd and tier-mapped sandbox", async () => {
    const { child, received } = scriptedChild({ withApproval: false });
    const driver = createCodexDriver({
      client: new CodexAppServer(() => child),
    });
    const threadIds: string[] = [];
    const events = await drain(
      driver.startTurn(baseInput({ onThreadId: (id) => threadIds.push(id) }))
        .events
    );
    const start = received.find((m) => m.method === "thread/start");
    expect(start?.params).toMatchObject({
      approvalPolicy: "on-request",
      cwd: "/wt/feat-a",
      sandbox: "workspace-write",
    });
    const turn = received.find((m) => m.method === "turn/start");
    expect(turn?.params).toMatchObject({
      cwd: "/wt/feat-a",
      input: [{ text: "go", type: "text" }],
      threadId: "th_9",
    });
    expect(threadIds).toEqual(["th_9"]);
    expect(events.some((e) => e.kind === "permission-request")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      kind: "turn-done",
      stopReason: "completed",
    });
  });

  test("approval request routes through requestPermission and answers accept/decline", async () => {
    const { child, received } = scriptedChild({ withApproval: true });
    const driver = createCodexDriver({
      client: new CodexAppServer(() => child),
    });
    const asked: string[] = [];
    await drain(
      driver.startTurn(
        baseInput({
          requestPermission: (request) => {
            asked.push(request.detail);
            return Promise.resolve(false);
          },
        })
      ).events
    );
    expect(asked).toEqual(["rm -rf build"]);
    const reply = received.find((m) => m.id === 77 && "result" in m);
    expect(reply?.result).toEqual({ decision: "decline" });
  });

  test("yolo tier maps to danger-full-access + never", async () => {
    const { child, received } = scriptedChild({ withApproval: false });
    const driver = createCodexDriver({
      client: new CodexAppServer(() => child),
    });
    await drain(driver.startTurn(baseInput({ tier: "yolo" })).events);
    const start = received.find((m) => m.method === "thread/start");
    expect(start?.params).toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });

  test("missing executable is an error event when no client injected", async () => {
    const driver = createCodexDriver({
      resolveExecutable: () => Promise.resolve(null),
    });
    const events = await drain(driver.startTurn(baseInput()).events);
    expect(events.some((e) => e.kind === "error")).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "turn-done", stopReason: "error" });
  });
});
