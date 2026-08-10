import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { StartTurnInput } from "@/ipc/agent/driver";
import { createCodexDriver } from "@/ipc/codex/adapter";
import { type ChildStdio, CodexAppServer } from "@/ipc/codex/app-server";
import type { AgentEvent } from "@/types/agent";

function scriptedChild(options: {
  withApproval: boolean;
  delayTurnAck?: boolean;
  killAfterTurnStart?: boolean;
}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const received: Record<string, unknown>[] = [];
  const exitCallbacks: (() => void)[] = [];
  let releaseAck: (() => void) | null = null;
  let buffer = "";
  function send(message: Record<string, unknown>): void {
    stdout.write(`${JSON.stringify(message)}\n`);
  }
  function finishTurn(): void {
    send({
      method: "item/agentMessage/delta",
      params: { delta: "done", threadId: "th_9" },
    });
    send({
      method: "turn/completed",
      params: { threadId: "th_9", turn: { status: "completed" } },
    });
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
      if (message.method === "thread/resume") {
        send({ id: message.id, result: {} });
      }
      if (message.method === "thread/inject_items") {
        send({ id: message.id, result: {} });
      }
      if (message.method === "turn/start") {
        const ack = () =>
          send({ id: message.id, result: { turnId: "turn_9" } });
        if (options.delayTurnAck) {
          releaseAck = ack;
          continue;
        }
        ack();
        if (options.killAfterTurnStart) {
          // Die without ever completing the turn.
          for (const cb of exitCallbacks) {
            cb();
          }
          continue;
        }
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
        finishTurn();
      }
      if (message.method === "turn/interrupt") {
        send({ id: message.id, result: {} });
        finishTurn();
      }
    }
  });
  const child: ChildStdio = {
    kill: () => {
      for (const cb of exitCallbacks) {
        cb();
      }
    },
    onExit: (cb) => exitCallbacks.push(cb),
    pid: 1,
    stdin,
    stdout,
  };
  return {
    child,
    received,
    releaseTurnAck: () => releaseAck?.(),
    send,
  };
}

function baseInput(overrides: Partial<StartTurnInput> = {}): StartTurnInput {
  return {
    onSessionId: () => undefined,
    onThreadId: () => undefined,
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

  test("a fresh thread injects prior history before turn/start; a resumed thread never injects", async () => {
    const fresh = scriptedChild({ withApproval: false });
    const freshDriver = createCodexDriver({
      client: new CodexAppServer(() => fresh.child),
    });
    const freshEvents = await drain(
      freshDriver.startTurn(
        baseInput({
          inject: [
            { role: "user", text: "earlier question" },
            { role: "assistant", text: "earlier answer" },
          ],
        })
      ).events
    );
    const injectCalls = fresh.received.filter(
      (m) => m.method === "thread/inject_items"
    );
    expect(injectCalls).toHaveLength(1);
    expect(injectCalls[0]?.params).toEqual({
      items: [
        {
          content: [{ text: "earlier question", type: "input_text" }],
          role: "user",
          type: "message",
        },
        {
          content: [{ text: "earlier answer", type: "output_text" }],
          role: "assistant",
          type: "message",
        },
      ],
      threadId: "th_9",
    });
    const injectIndex = fresh.received.findIndex(
      (m) => m.method === "thread/inject_items"
    );
    const turnStartIndex = fresh.received.findIndex(
      (m) => m.method === "turn/start"
    );
    expect(injectIndex).toBeGreaterThanOrEqual(0);
    expect(injectIndex).toBeLessThan(turnStartIndex);
    expect(freshEvents.at(-1)).toMatchObject({
      kind: "turn-done",
      stopReason: "completed",
    });

    const resumed = scriptedChild({ withApproval: false });
    const resumedDriver = createCodexDriver({
      client: new CodexAppServer(() => resumed.child),
    });
    const resumedEvents = await drain(
      resumedDriver.startTurn(
        baseInput({
          inject: [{ role: "user", text: "should never be sent" }],
          resume: { sessionId: null, threadId: "th_9" },
        })
      ).events
    );
    expect(resumed.received.some((m) => m.method === "thread/resume")).toBe(
      true
    );
    expect(
      resumed.received.some((m) => m.method === "thread/inject_items")
    ).toBe(false);
    expect(resumedEvents.at(-1)).toMatchObject({
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
    const events = await drain(
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
    // The manager owns permission events; the adapter stream must not
    // duplicate them.
    expect(
      events.some(
        (e) =>
          e.kind === "permission-request" || e.kind === "permission-resolved"
      )
    ).toBe(false);
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
    expect(events.at(-1)).toMatchObject({
      kind: "turn-done",
      stopReason: "error",
    });
  });

  test("onSpawn receives the app-server child's pid when a fresh client is built", async () => {
    const pids: number[] = [];
    const driver = createCodexDriver({
      onSpawn: (pid) => pids.push(pid),
      // "echo" is a real, near-instantly-exiting binary standing in for
      // codex here: onSpawn fires synchronously inside connect(), before any
      // JSON-RPC round trip, so the (expected) handshake failure once echo
      // exits does not affect this assertion.
      resolveExecutable: () => Promise.resolve("echo"),
    });
    await drain(driver.startTurn(baseInput()).events);
    expect(pids).toHaveLength(1);
    expect(pids[0]).toBeGreaterThan(0);
  });

  test("a codex crash mid-turn closes the turn instead of hanging", async () => {
    const { child } = scriptedChild({
      killAfterTurnStart: true,
      withApproval: false,
    });
    const driver = createCodexDriver({
      client: new CodexAppServer(() => child),
    });
    const events = await drain(driver.startTurn(baseInput()).events);
    expect(events.some((e) => e.kind === "error")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      kind: "turn-done",
      stopReason: "error",
    });
  });

  test("an interrupt before the turn ack is delivered after it", async () => {
    const { child, received, releaseTurnAck } = scriptedChild({
      delayTurnAck: true,
      withApproval: false,
    });
    const driver = createCodexDriver({
      client: new CodexAppServer(() => child),
    });
    const handle = driver.startTurn(baseInput());
    const drained = drain(handle.events);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await handle.interrupt(); // the ack has not returned yet — must not be lost
    releaseTurnAck();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const interruptMessage = received.find(
      (m) => m.method === "turn/interrupt"
    );
    expect(interruptMessage?.params).toMatchObject({
      threadId: "th_9",
      turnId: "turn_9",
    });
    await drained;
  });
});
