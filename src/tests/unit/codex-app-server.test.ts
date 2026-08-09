import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { CodexAppServer, type ChildStdio } from "@/ipc/codex/app-server";

/** An in-memory fake codex child speaking JSONL on the same duplex pair. */
function fakeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const exitCallbacks: (() => void)[] = [];
  const received: Record<string, unknown>[] = [];
  let buffer = "";
  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim().length > 0) {
        const message = JSON.parse(line) as Record<string, unknown>;
        received.push(message);
        // Auto-answer the handshake so tests exercise the rest.
        if (message.method === "initialize") {
          send({ id: message.id, result: {} });
        }
      }
      index = buffer.indexOf("\n");
    }
  });
  function send(message: Record<string, unknown>): void {
    stdout.write(`${JSON.stringify(message)}\n`);
  }
  const child: ChildStdio = {
    kill: () => {
      for (const cb of exitCallbacks) {
        cb();
      }
    },
    onExit: (cb) => exitCallbacks.push(cb),
    pid: 4242,
    stdin,
    stdout,
  };
  return { child, received, send };
}

describe("CodexAppServer", () => {
  test("handshakes once, then routes responses by id", async () => {
    const { child, received, send } = fakeChild();
    const client = new CodexAppServer(() => child);
    const pending = client.request("thread/start", { cwd: "/wt/a" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const threadStart = received.find((m) => m.method === "thread/start");
    expect(threadStart).toBeDefined();
    expect(received[0]?.method).toBe("initialize");
    expect(received.some((m) => m.method === "initialized")).toBe(true);
    send({ id: threadStart?.id, result: { threadId: "th_1" } });
    await expect(pending).resolves.toEqual({ threadId: "th_1" });
  });

  test("split JSONL frames reassemble across chunk boundaries", async () => {
    const { child, send } = fakeChild();
    const client = new CodexAppServer(() => child);
    const notifications: [string, unknown][] = [];
    client.onNotification((method, params) => notifications.push([method, params]));
    // Fire-and-forget just to trigger connection — this request is never
    // answered by the fake and must not be awaited (30s timeout).
    void client.request("thread/start", {}).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Write one notification in two raw chunks.
    const line = `${JSON.stringify({
      method: "item/agentMessage/delta",
      params: { delta: "hi" },
    })}\n`;
    (child.stdout as PassThrough).write(line.slice(0, 12));
    (child.stdout as PassThrough).write(line.slice(12));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(notifications).toContainEqual([
      "item/agentMessage/delta",
      { delta: "hi" },
    ]);
    client.dispose(); // clears the unanswered request's 30s timer
  });

  test("server-to-client requests are answered through the handler", async () => {
    const { child, received, send } = fakeChild();
    const client = new CodexAppServer(() => child);
    client.onRequest((method) =>
      method === "item/commandExecution/requestApproval"
        ? { decision: "accept" }
        : { decision: "decline" }
    );
    // Trigger connection.
    const pending = client.request("thread/start", {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    send({
      id: 999,
      method: "item/commandExecution/requestApproval",
      params: { command: "ls", itemId: "i1", threadId: "t", turnId: "u" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reply = received.find((m) => m.id === 999 && "result" in m);
    expect(reply?.result).toEqual({ decision: "accept" });
    const start = received.find((m) => m.method === "thread/start");
    send({ id: start?.id, result: {} });
    await pending;
  });

  test("dispose rejects everything pending", async () => {
    const { child } = fakeChild();
    const client = new CodexAppServer(() => child);
    const pending = client.request("thread/start", {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    client.dispose();
    await expect(pending).rejects.toThrow();
  });
});
