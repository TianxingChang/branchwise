import { describe, expect, test } from "vitest";
import { appendToScrollback } from "@/lib/terminal/buffer";
import { EventQueue } from "@/lib/terminal/queue";
import type { TerminalEvent } from "@/types/terminal";

describe("appendToScrollback", () => {
  test("keeps everything while under the limit", () => {
    expect(appendToScrollback("ab", "cd", 10)).toBe("abcd");
  });

  test("drops the oldest content once over the limit", () => {
    const result = appendToScrollback("aaaaa", "bbbbb", 6);

    expect(result.length).toBeLessThanOrEqual(6);
    expect(result.endsWith("bbbbb")).toBe(true);
  });

  test("cuts at a line boundary rather than mid-escape", () => {
    // A naive slice would leave "31mred" — the tail of a colour code rendered
    // as text. Cutting at the newline keeps every retained line intact.
    const existing = "first\n[31mred line[0m\n";
    const result = appendToScrollback(existing, "next\n", 20);

    expect(result.includes("31m")).toBe(false);
    expect(result).toBe("next\n");
  });

  test("falls back to a hard cut when there is no newline to cut at", () => {
    const result = appendToScrollback("x".repeat(20), "y".repeat(5), 10);

    expect(result).toHaveLength(10);
    expect(result.endsWith("yyyyy")).toBe(true);
  });

  test("handles a single chunk larger than the whole limit", () => {
    const result = appendToScrollback("", "z".repeat(50), 10);

    expect(result).toHaveLength(10);
  });
});

function dataQueue() {
  return new EventQueue<TerminalEvent>({
    merge: (left, right) =>
      left.kind === "data" && right.kind === "data"
        ? { data: left.data + right.data, kind: "data" }
        : null,
  });
}

describe("EventQueue", () => {
  test("delivers queued events in order", async () => {
    const queue = dataQueue();
    queue.push({ data: "a", kind: "data" });
    queue.push({ exitCode: 0, kind: "exit", signal: null });
    queue.close();

    const seen: TerminalEvent[] = [];
    for await (const event of queue.iterate()) {
      seen.push(event);
    }

    expect(seen).toEqual([
      { data: "a", kind: "data" },
      { exitCode: 0, kind: "exit", signal: null },
    ]);
  });

  test("merges adjacent output so throughput cannot grow the queue", () => {
    const queue = dataQueue();
    for (let index = 0; index < 500; index += 1) {
      queue.push({ data: "x", kind: "data" });
    }

    expect(queue.size).toBe(1);
  });

  test("does not merge output across an exit", () => {
    const queue = dataQueue();
    queue.push({ data: "a", kind: "data" });
    queue.push({ exitCode: 1, kind: "exit", signal: null });
    queue.push({ data: "b", kind: "data" });

    expect(queue.size).toBe(3);
  });

  test("wakes a waiting consumer when an event arrives", async () => {
    const queue = dataQueue();
    const iterator = queue.iterate();
    const pending = iterator.next();

    queue.push({ data: "later", kind: "data" });

    expect((await pending).value).toEqual({ data: "later", kind: "data" });
  });

  test("ends the iteration when closed while waiting", async () => {
    const queue = dataQueue();
    const iterator = queue.iterate();
    const pending = iterator.next();

    queue.close();

    expect((await pending).done).toBe(true);
  });

  test("ends the iteration when the consumer aborts", async () => {
    const queue = dataQueue();
    const controller = new AbortController();
    const iterator = queue.iterate(controller.signal);
    const pending = iterator.next();

    controller.abort();

    expect((await pending).done).toBe(true);
  });

  test("ignores events pushed after close", () => {
    const queue = dataQueue();
    queue.close();
    queue.push({ data: "ignored", kind: "data" });

    expect(queue.size).toBe(0);
  });
});
