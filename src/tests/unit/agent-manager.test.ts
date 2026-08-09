import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentDriver, StartTurnInput } from "@/ipc/agent/driver";
import {
  _resetManagerForTests,
  attachAgent,
  configureManager,
  detachAgent,
  getConfig,
  interruptTurn,
  readHistory,
  respondPermission,
  send,
  setConfig,
  shutdownAgents,
} from "@/ipc/agent/manager";
import type { AgentEvent } from "@/types/agent";

const WT = "/wt/feat-a";
let base = "";

/** A driver whose event stream the test hand-feeds. */
function puppetDriver(id: "claude-code" | "codex" = "claude-code") {
  let push: ((event: AgentEvent | null) => void) | null = null;
  let raise: ((error: Error) => void) | null = null;
  let lastInput: StartTurnInput | null = null;
  const driver: AgentDriver = {
    id,
    shutdown: () => Promise.resolve(),
    startTurn: (input) => {
      lastInput = input;
      const buffered: (AgentEvent | null)[] = [];
      let pendingError: Error | null = null;
      let wake: (() => void) | null = null;
      push = (event) => {
        buffered.push(event);
        wake?.();
        wake = null;
      };
      raise = (error) => {
        pendingError = error;
        wake?.();
        wake = null;
      };
      return {
        events: (async function* () {
          for (;;) {
            if (pendingError) {
              throw pendingError;
            }
            const next = buffered.shift();
            if (next === null) {
              return;
            }
            if (next) {
              yield next;
              continue;
            }
            // Sequential by nature: this await *is* the wait for the next
            // fed event.
            // biome-ignore lint/performance/noAwaitInLoops: see above
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        })(),
        interrupt: () => {
          push?.({
            costUsd: null,
            kind: "turn-done",
            stopReason: "interrupted",
            turnId: "t1",
            usage: null,
          });
          push?.(null);
          return Promise.resolve();
        },
      };
    },
  };
  return {
    crash: (error: Error) => raise?.(error),
    driver,
    end: () => push?.(null),
    feed: (event: AgentEvent) => push?.(event),
    input: () => lastInput,
  };
}

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "bw-manager-"));
  vi.useFakeTimers();
});
afterEach(async () => {
  vi.useRealTimers();
  _resetManagerForTests();
  await rm(base, { force: true, recursive: true });
});

async function pull(
  queue: ReturnType<typeof attachAgent>["queue"],
  count: number
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  const iterator = queue.iterate()[Symbol.asyncIterator]();
  while (out.length < count) {
    // Sequential by nature: each pump must land before the next iterator
    // read, so Promise.all across iterations would not preserve order.
    // biome-ignore lint/performance/noAwaitInLoops: see above
    await vi.advanceTimersByTimeAsync(60);
    const { done, value } = await iterator.next();
    if (done) {
      break;
    }
    out.push(value);
  }
  return out;
}

/**
 * Pumps the fake clock in many small steps rather than one big jump.
 *
 * The manager's event loop awaits a real transcript fs write between driver
 * events (so history stays ordered), and `vi.advanceTimersByTimeAsync`
 * reliably drains a *pending* timer but gives no guarantee about how many
 * real-I/O round trips complete inside a single call when nothing is due
 * yet. Repeating small steps gives that chain many more chances to settle
 * than one large one — the same trick `pull()` above already relies on by
 * looping its own advance call once per expected event.
 */
async function settle(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    // Sequential by nature: each pump must land before the next, advancing
    // the fake clock in small cumulative steps rather than one big jump.
    // biome-ignore lint/performance/noAwaitInLoops: see above
    await vi.advanceTimersByTimeAsync(10);
  }
}

describe("agent session manager", () => {
  test("send emits user-message, coalesces deltas, transcript survives", async () => {
    const puppet = puppetDriver();
    configureManager({
      baseDir: base,
      drivers: { "claude-code": puppet.driver },
    });
    await setConfig(WT, { driverId: "claude-code", tier: "accept-edits" });

    const { queue, replay } = attachAgent(WT);
    expect(replay).toEqual([]);

    expect((await send(WT, "hello agent")).accepted).toBe(true);
    puppet.feed({ kind: "turn-started", turnId: "t1" });
    puppet.feed({ kind: "text-delta", text: "a" });
    puppet.feed({ kind: "text-delta", text: "b" });
    puppet.feed({ kind: "text-delta", text: "c" });
    puppet.feed({
      costUsd: 0.2,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "t1",
      usage: null,
    });
    puppet.end();

    const events = await pull(queue, 4);
    expect(events[0]).toEqual({ kind: "user-message", text: "hello agent" });
    expect(events[1]).toEqual({ kind: "turn-started", turnId: "t1" });
    // The three deltas crossed as one coalesced event (50ms tick or flush on
    // the non-delta turn-done, whichever came first).
    expect(events[2]).toEqual({ kind: "text-delta", text: "abc" });
    expect(events[3]).toMatchObject({ kind: "turn-done" });
    detachAgent(WT, queue);

    const history = await readHistory(WT);
    expect(history.map((e) => e.kind)).toEqual([
      "user-message",
      "turn-started",
      "text-delta",
      "turn-done",
    ]);
  });

  test("second send while a turn is active is refused", async () => {
    const puppet = puppetDriver();
    configureManager({
      baseDir: base,
      drivers: { "claude-code": puppet.driver },
    });
    await setConfig(WT, { driverId: "claude-code", tier: "ask" });
    await send(WT, "one");
    const second = await send(WT, "two");
    expect(second.accepted).toBe(false);
    puppet.feed({
      costUsd: null,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "t1",
      usage: null,
    });
    puppet.end();
  });

  test("attach mid-turn replays flushed events; re-attach does not duplicate", async () => {
    const puppet = puppetDriver();
    configureManager({
      baseDir: base,
      drivers: { "claude-code": puppet.driver },
    });
    await setConfig(WT, { driverId: "claude-code", tier: "accept-edits" });
    await send(WT, "hi");
    puppet.feed({ kind: "turn-started", turnId: "t1" });
    puppet.feed({ kind: "text-delta", text: "stream" });
    await settle();

    const first = attachAgent(WT);
    expect(first.replay.map((e) => e.kind)).toEqual([
      "user-message",
      "turn-started",
      "text-delta",
    ]);
    detachAgent(WT, first.queue);
    const second = attachAgent(WT);
    expect(second.replay).toEqual(first.replay);
    detachAgent(WT, second.queue);
    puppet.feed({
      costUsd: null,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "t1",
      usage: null,
    });
    puppet.end();
  });

  test("permission requests park until respondPermission, then resolve", async () => {
    const puppet = puppetDriver();
    configureManager({
      baseDir: base,
      drivers: { "claude-code": puppet.driver },
    });
    await setConfig(WT, { driverId: "claude-code", tier: "ask" });
    await send(WT, "run it");

    let verdict: boolean | null = null;
    puppet
      .input()
      ?.requestPermission({
        detail: "npm test",
        requestId: "r1",
        toolName: "Bash",
      })
      .then((approved) => {
        verdict = approved;
      });
    await vi.advanceTimersByTimeAsync(10);
    expect(verdict).toBeNull();
    expect(respondPermission(WT, "r1", true)).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(verdict).toBe(true);
    puppet.feed({
      costUsd: null,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "t1",
      usage: null,
    });
    puppet.end();
  });

  test("unanswered permission denies after the 5 minute timeout", async () => {
    const puppet = puppetDriver();
    configureManager({
      baseDir: base,
      drivers: { "claude-code": puppet.driver },
    });
    await setConfig(WT, { driverId: "claude-code", tier: "ask" });
    await send(WT, "run it");
    let verdict: boolean | null = null;
    puppet
      .input()
      ?.requestPermission({ detail: "x", requestId: "r2", toolName: "Bash" })
      .then((approved) => {
        verdict = approved;
      });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 50);
    expect(verdict).toBe(false);
    puppet.end();
  });

  test("interrupt reaches the driver and the turn closes", async () => {
    const puppet = puppetDriver();
    configureManager({
      baseDir: base,
      drivers: { "claude-code": puppet.driver },
    });
    await setConfig(WT, { driverId: "claude-code", tier: "accept-edits" });
    await send(WT, "long task");
    puppet.feed({ kind: "turn-started", turnId: "t1" });
    await interruptTurn(WT);
    await settle();
    const history = await readHistory(WT);
    expect(history.at(-1)).toMatchObject({
      kind: "turn-done",
      stopReason: "interrupted",
    });
  });

  test("session ids persist into the registry via callbacks", async () => {
    const puppet = puppetDriver();
    configureManager({
      baseDir: base,
      drivers: { "claude-code": puppet.driver },
    });
    await setConfig(WT, { driverId: "claude-code", tier: "accept-edits" });
    await send(WT, "hi");
    puppet.input()?.onSessionId("sess-42");
    puppet.feed({
      costUsd: null,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "t1",
      usage: null,
    });
    puppet.end();
    await settle();

    _resetManagerForTests();
    configureManager({
      baseDir: base,
      drivers: { "claude-code": puppet.driver },
    });
    await send(WT, "again");
    expect(puppet.input()?.resume.sessionId).toBe("sess-42");
    puppet.end();
  });

  // --- Carried pointer (Task 2 review): saveRegistry's fixed .tmp name can
  // race concurrent saves. The manager is the only writer and setConfig /
  // persistIds / send can overlap, so writes must be serialized to avoid a
  // lost-update when two mutations race the same registry.json.
  test("concurrent setConfig calls across worktrees do not lose updates (serialized registry writes)", async () => {
    const puppet = puppetDriver();
    configureManager({
      baseDir: base,
      drivers: { "claude-code": puppet.driver },
    });

    await Promise.all([
      setConfig("/wt/a", { driverId: "claude-code", tier: "ask" }),
      setConfig("/wt/b", { driverId: "codex", tier: "yolo" }),
      setConfig("/wt/c", { driverId: "claude-code", tier: "plan" }),
    ]);

    expect((await getConfig("/wt/a")).config).toEqual({
      driverId: "claude-code",
      tier: "ask",
    });
    expect((await getConfig("/wt/b")).config).toEqual({
      driverId: "codex",
      tier: "yolo",
    });
    expect((await getConfig("/wt/c")).config).toEqual({
      driverId: "claude-code",
      tier: "plan",
    });
  });

  // --- Carried pointer (Task 8 review): a permission request is left
  // dangling if a driver crashes/is interrupted while the approval is
  // outstanding. The 5-minute timeout bounds it, but interruptTurn and
  // shutdown must resolve (deny) parked permissions immediately so nothing
  // waits the full 5 minutes after the turn is already dead.
  test("interrupt denies a parked permission for that worktree instead of waiting out the timeout", async () => {
    const puppet = puppetDriver();
    configureManager({
      baseDir: base,
      drivers: { "claude-code": puppet.driver },
    });
    await setConfig(WT, { driverId: "claude-code", tier: "ask" });
    await send(WT, "run it");

    let verdict: boolean | null = null;
    puppet
      .input()
      ?.requestPermission({
        detail: "rm -rf /",
        requestId: "r3",
        toolName: "Bash",
      })
      .then((approved) => {
        verdict = approved;
      });
    await vi.advanceTimersByTimeAsync(10);
    expect(verdict).toBeNull();

    await interruptTurn(WT);
    await vi.advanceTimersByTimeAsync(10);
    expect(verdict).toBe(false);
  });

  test("shutdownAgents denies any still-parked permission instead of waiting out the timeout", async () => {
    const puppet = puppetDriver();
    configureManager({
      baseDir: base,
      drivers: { "claude-code": puppet.driver },
    });
    await setConfig(WT, { driverId: "claude-code", tier: "ask" });
    await send(WT, "run it");

    let verdict: boolean | null = null;
    puppet
      .input()
      ?.requestPermission({
        detail: "rm -rf /",
        requestId: "r4",
        toolName: "Bash",
      })
      .then((approved) => {
        verdict = approved;
      });
    await vi.advanceTimersByTimeAsync(10);
    expect(verdict).toBeNull();

    await shutdownAgents(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(verdict).toBe(false);
  });

  // --- Review finding 2: send() had no synchronous latch, so two sends
  // racing through the pre-start fs reads could both reach startTurn.
  test("two racing sends accept exactly one", async () => {
    const puppet = puppetDriver();
    configureManager({
      baseDir: base,
      drivers: { "claude-code": puppet.driver },
    });
    await setConfig(WT, { driverId: "claude-code", tier: "ask" });

    const [first, second] = await Promise.all([
      send(WT, "one"),
      send(WT, "two"),
    ]);
    const accepted = [first.accepted, second.accepted];
    expect(accepted.filter(Boolean)).toHaveLength(1);
    // The loser must have been refused synchronously (before startTurn), not
    // by racing into a real turn of its own.
    expect(accepted).toContain(false);

    puppet.feed({
      costUsd: null,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "t1",
      usage: null,
    });
    puppet.end();
  });

  // --- Review finding 3: deltas flushed through separate pendingText /
  // pendingThinking fields always emitted text before thinking, inverting a
  // thinking→text transition inside one 50ms window.
  test("a thinking-then-text transition inside one flush window keeps arrival order", async () => {
    const puppet = puppetDriver();
    configureManager({
      baseDir: base,
      drivers: { "claude-code": puppet.driver },
    });
    await setConfig(WT, { driverId: "claude-code", tier: "accept-edits" });
    const { queue } = attachAgent(WT);

    await send(WT, "hi");
    puppet.feed({ kind: "turn-started", turnId: "t1" });
    puppet.feed({ kind: "thinking-delta", text: "hmm " });
    puppet.feed({ kind: "thinking-delta", text: "well " });
    puppet.feed({ kind: "text-delta", text: "answer" });
    puppet.feed({
      costUsd: null,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "t1",
      usage: null,
    });
    puppet.end();

    const events = await pull(queue, 5);
    expect(events.map((e) => e.kind)).toEqual([
      "user-message",
      "turn-started",
      "thinking-delta",
      "text-delta",
      "turn-done",
    ]);
    expect(events[2]).toEqual({ kind: "thinking-delta", text: "hmm well " });
    expect(events[3]).toEqual({ kind: "text-delta", text: "answer" });
  });

  // --- Review finding 4: the stream-error path never denied parked
  // permissions, so a crash mid-turn left requestPermission waiting the
  // full 5 minutes even though the turn producing the approval was dead.
  test("a stream error denies a parked permission immediately instead of waiting out the timeout", async () => {
    const puppet = puppetDriver();
    configureManager({
      baseDir: base,
      drivers: { "claude-code": puppet.driver },
    });
    await setConfig(WT, { driverId: "claude-code", tier: "ask" });
    await send(WT, "run it");

    let verdict: boolean | null = null;
    puppet
      .input()
      ?.requestPermission({
        detail: "rm -rf /",
        requestId: "r5",
        toolName: "Bash",
      })
      .then((approved) => {
        verdict = approved;
      });
    await vi.advanceTimersByTimeAsync(10);
    expect(verdict).toBeNull();

    puppet.crash(new Error("driver exploded"));
    await settle();
    expect(verdict).toBe(false);

    const history = await readHistory(WT);
    expect(history.at(-1)).toMatchObject({
      kind: "turn-done",
      stopReason: "error",
    });
  });
});
