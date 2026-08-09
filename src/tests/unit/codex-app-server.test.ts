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

  test("a child crash resets state so the next request reconnects cleanly", async () => {
    let spawned = 0;
    const children: ReturnType<typeof fakeChild>[] = [];
    const client = new CodexAppServer(() => {
      spawned += 1;
      const fake = fakeChild();
      children.push(fake);
      return fake.child;
    });
    const first = client.request("thread/start", {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Die mid-line: the torn fragment must not prefix generation two.
    (children[0]?.child.stdout as PassThrough).write('{"partial');
    children[0]?.child.kill();
    await expect(first).rejects.toThrow();

    const second = client.request("thread/start", {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(spawned).toBe(2);
    const start = children[1]?.received.find(
      (m) => m.method === "thread/start"
    );
    expect(start).toBeDefined();
    children[1]?.send({ id: start?.id, result: { threadId: "th_2" } });
    await expect(second).resolves.toEqual({ threadId: "th_2" });

    // A stale exit from the dead generation must not touch the live one:
    // re-firing generation one's exit callbacks and then making a third
    // request must neither respawn nor break generation two.
    children[0]?.child.kill();
    const third = client.request("thread/status", {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(spawned).toBe(2);
    const status = children[1]?.received.find(
      (m) => m.method === "thread/status"
    );
    expect(status).toBeDefined();
    children[1]?.send({ id: status?.id, result: { ok: true } });
    await expect(third).resolves.toEqual({ ok: true });
  });

  test("a synchronously throwing request handler becomes an error reply", async () => {
    const { child, received, send } = fakeChild();
    const client = new CodexAppServer(() => child);
    client.onRequest(() => {
      throw new Error("handler blew up");
    });
    const pending = client.request("thread/start", {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    send({ id: 55, method: "item/commandExecution/requestApproval", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reply = received.find((m) => m.id === 55 && "error" in m);
    expect(reply).toBeDefined();
    const start = received.find((m) => m.method === "thread/start");
    send({ id: start?.id, result: {} });
    await pending;
  });

  test("a handler returning undefined passes the request to the next one", async () => {
    const { child, received, send } = fakeChild();
    const client = new CodexAppServer(() => child);
    client.onRequest(() => undefined);
    client.onRequest(() => ({ decision: "accept" }));
    const pending = client.request("thread/start", {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    send({ id: 77, method: "item/fileChange/requestApproval", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reply = received.find((m) => m.id === 77 && "result" in m);
    expect(reply?.result).toEqual({ decision: "accept" });
    const start = received.find((m) => m.method === "thread/start");
    send({ id: start?.id, result: {} });
    await pending;
  });

  test("requests dispatch only after same-chunk responses have settled", async () => {
    const { child, received } = fakeChild();
    const client = new CodexAppServer(() => child);
    let settled = false;
    const pending = client.request("thread/start", {}).then((result) => {
      settled = true;
      return result;
    });
    const seenSettled: boolean[] = [];
    client.onRequest(() => {
      seenSettled.push(settled);
      return { decision: "decline" };
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const start = received.find((m) => m.method === "thread/start");
    // One chunk: our response immediately followed by a server request.
    (child.stdout as PassThrough).write(
      `${JSON.stringify({ id: start?.id, result: { threadId: "th_1" } })}\n${JSON.stringify(
        { id: 88, method: "item/permissions/requestApproval", params: {} }
      )}\n`
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await pending;
    expect(seenSettled).toEqual([true]);
  });
});
