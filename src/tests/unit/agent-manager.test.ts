import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readPendingInheritance } from "@/ipc/agent/inheritance";
import {
  _resetManagerForTests,
  attachAgent,
  configureManager,
  detachAgent,
  getConfig,
  interruptTurn,
  prepareInheritance,
  readHistory,
  respondPermission,
  send,
  setConfig,
  shutdownAgents,
} from "@/ipc/agent/manager";
import { loadRegistry } from "@/ipc/agent/registry";
import type { AgentEvent } from "@/types/agent";
import { puppetDriver } from "./helpers/puppet-driver";

const WT = "/wt/feat-a";
let base = "";

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
 * Pumps the fake clock in small cumulative steps until `condition` holds,
 * rather than spending one fixed budget.
 *
 * The manager's event loop awaits a real transcript (or registry) fs write
 * between driver events (so history stays ordered), and
 * `vi.advanceTimersByTimeAsync` reliably drains a *pending* timer but gives
 * no guarantee about how many real-I/O round trips complete inside a single
 * call when nothing is due yet — the same trick `pull()` above already
 * relies on by looping its own advance call once per expected event. A
 * fixed round count previously used here could return control to a test
 * (and then to afterEach, which nulls baseDir) before a real fs write
 * settled, producing an unhandled rejection from the next baseDir() call
 * deep inside the now-stale write — the exact flake this polls away.
 * roundsCap bounds the loop so a genuinely wrong condition still fails
 * fast, with a clear message, instead of hanging the suite.
 */
async function settleUntil(
  condition: () => boolean | Promise<boolean>,
  roundsCap = 200
): Promise<void> {
  for (let i = 0; i < roundsCap; i += 1) {
    // Sequential by nature: each check must land before the next advance.
    // biome-ignore lint/performance/noAwaitInLoops: see above
    if (await condition()) {
      return;
    }
    await vi.advanceTimersByTimeAsync(10);
  }
  if (!(await condition())) {
    throw new Error(
      `settleUntil: condition still false after ${roundsCap} rounds (${roundsCap * 10}ms of fake time)`
    );
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
    // The replay buffer below is in-memory, but it is only populated after
    // the same transcript fs write settleUntil() polls for (see emit()).
    await settleUntil(async () =>
      (await readHistory(WT)).some((e) => e.kind === "text-delta")
    );

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
    // tsc (strict null checks) reports TS2531 without this `?.`; puppet.input()
    // is typed StartTurnInput | null and biome's cross-module inference
    // disagrees with tsc here — trust tsc.
    // biome-ignore lint/suspicious/noUnnecessaryConditions: see above
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
    // Both permission events must reach the transcript — the UI's approval
    // card and its resolution render from these, for both vendors. A single
    // advance is not reliable here: each event's transcript write is real
    // fs I/O (see settleUntil()'s doc comment). permission-resolved is
    // always chained after permission-request on this worktree's serial
    // emit chain, so polling for the former guarantees the latter already
    // landed.
    await settleUntil(async () =>
      (await readHistory(WT)).some(
        (e) => e.kind === "permission-resolved" && e.requestId === "r1"
      )
    );
    const history = await readHistory(WT);
    expect(
      history.some(
        (e) => e.kind === "permission-request" && e.requestId === "r1"
      )
    ).toBe(true);
    expect(
      history.some(
        (e) =>
          e.kind === "permission-resolved" &&
          e.requestId === "r1" &&
          e.approved === true
      )
    ).toBe(true);
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
    // tsc (strict null checks) reports TS2531 without this `?.`; puppet.input()
    // is typed StartTurnInput | null and biome's cross-module inference
    // disagrees with tsc here — trust tsc.
    // biome-ignore lint/suspicious/noUnnecessaryConditions: see above
    puppet
      .input()
      ?.requestPermission({ detail: "x", requestId: "r2", toolName: "Bash" })
      .then((approved) => {
        verdict = approved;
      });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 50);
    expect(verdict).toBe(false);
    // Drain the timeout's permission-resolved emit (real fs I/O) before the
    // test ends, so it cannot resolve after afterEach() nulls out baseDir.
    await settleUntil(async () =>
      (await readHistory(WT)).some(
        (e) => e.kind === "permission-resolved" && e.requestId === "r2"
      )
    );
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
    await settleUntil(async () =>
      (await readHistory(WT)).some(
        (e) => e.kind === "turn-done" && e.stopReason === "interrupted"
      )
    );
    const history = await readHistory(WT);
    expect(history.at(-1)).toMatchObject({
      kind: "turn-done",
      stopReason: "interrupted",
    });
  });

  // --- Final-review finding: interrupt authority cannot depend on the
  // vendor cooperating. A wedged-but-alive codex child can ack
  // turn/interrupt (handle.interrupt() resolves) and then never send
  // turn/completed — without a bound, the drain waits forever and the
  // worktree's slot is stuck until app restart.
  test("a wedged turn that acks interrupt but never completes force-closes after the grace period", async () => {
    const puppet = puppetDriver("claude-code", { wedgeInterrupt: true });
    configureManager({
      baseDir: base,
      drivers: { "claude-code": puppet.driver },
    });
    await setConfig(WT, { driverId: "claude-code", tier: "accept-edits" });
    await send(WT, "long task");
    puppet.feed({ kind: "turn-started", turnId: "t1" });

    await interruptTurn(WT);
    // The ack resolved, but the wedged stream never yields turn-done: the
    // slot must still read occupied until the grace period elapses.
    expect((await send(WT, "too soon")).accepted).toBe(false);

    // Cross the grace boundary, then poll (a bigger cap than settleUntil's
    // default: 3s of fake time to cross INTERRUPT_GRACE_MS, plus room for
    // the forced turn-done's real transcript write to land).
    await settleUntil(
      async () =>
        (await readHistory(WT)).some(
          (e) => e.kind === "turn-done" && e.turnId === "forced"
        ),
      400
    );

    const history = await readHistory(WT);
    expect(history.at(-1)).toMatchObject({
      kind: "turn-done",
      stopReason: "interrupted",
      turnId: "forced",
    });

    // The slot is free: a second send is accepted rather than refused.
    const second = await send(WT, "back to work");
    expect(second.accepted).toBe(true);
    puppet.feed({
      costUsd: null,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "t2",
      usage: null,
    });
    puppet.end();
  });

  // --- A late real terminal event, arriving after the grace already forced
  // the turn closed, must not resurrect or duplicate anything: the pump's
  // `live !== turn` superseded guard is what absorbs it.
  test("a real turn-done that lands after the grace already fired is absorbed, not duplicated", async () => {
    const puppet = puppetDriver("claude-code", { wedgeInterrupt: true });
    configureManager({
      baseDir: base,
      drivers: { "claude-code": puppet.driver },
    });
    await setConfig(WT, { driverId: "claude-code", tier: "accept-edits" });
    await send(WT, "long task");
    puppet.feed({ kind: "turn-started", turnId: "t1" });

    await interruptTurn(WT);
    await settleUntil(
      async () =>
        (await readHistory(WT)).some(
          (e) => e.kind === "turn-done" && e.turnId === "forced"
        ),
      400
    );

    // The original turn's stream finally does terminate for real, well
    // after the grace already forced it closed and no second send() has
    // replaced the puppet's push/raise closures yet — this reaches the
    // original (now-superseded) generator directly.
    puppet.feed({
      costUsd: null,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "t1",
      usage: null,
    });
    puppet.end();
    // Give the (superseded) pump every chance to wrongly process this —
    // if the `live !== turn` guard were broken, this would append a second
    // turn-done here.
    for (let i = 0; i < 20; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: draining, see settleUntil above
      await vi.advanceTimersByTimeAsync(10);
    }

    const history = await readHistory(WT);
    expect(history.filter((e) => e.kind === "turn-done")).toHaveLength(1);
    expect(history.at(-1)).toMatchObject({
      kind: "turn-done",
      turnId: "forced",
    });
  });

  // --- Follow-up review finding: the grace force-close frees the slot
  // while the ORIGINAL turn's pump keeps running — it is orphaned, still
  // suspended in its own for-await over the (still wedged) generator, not
  // cancelled. If that orphaned stream later throws for real, its
  // catch/finally must not pollute a NEWER turn's transcript (a phantom
  // turn-done{turnId:"stream"}) or deny that newer turn's permissions —
  // pendingPermissions is keyed only by worktreePath, not by turn, so an
  // unguarded denyPendingPermissions() would deny the wrong turn's request.
  test("an orphaned pump's late failure does not pollute a newer turn's transcript or deny its permission", async () => {
    const puppet = puppetDriver("claude-code", { wedgeInterrupt: true });
    configureManager({
      baseDir: base,
      drivers: { "claude-code": puppet.driver },
    });
    await setConfig(WT, { driverId: "claude-code", tier: "accept-edits" });

    // Turn 1: wedge it, interrupt, force-close via the grace.
    await send(WT, "first task");
    puppet.feed({ kind: "turn-started", turnId: "t1" });
    await interruptTurn(WT);
    await settleUntil(
      async () =>
        (await readHistory(WT)).some(
          (e) => e.kind === "turn-done" && e.turnId === "forced"
        ),
      400
    );

    // Turn 2: the slot is free; a new turn starts and parks a permission.
    await send(WT, "second task");
    let verdict: boolean | null = null;
    // tsc (strict null checks) reports TS2531 without this `?.`; puppet.input()
    // is typed StartTurnInput | null and biome's cross-module inference
    // disagrees with tsc here — trust tsc.
    // biome-ignore lint/suspicious/noUnnecessaryConditions: see above
    puppet
      .input()
      ?.requestPermission({
        detail: "rm -rf /",
        requestId: "r-second",
        toolName: "Bash",
      })
      .then((approved) => {
        verdict = approved;
      });
    await settleUntil(async () =>
      (await readHistory(WT)).some(
        (e) => e.kind === "permission-request" && e.requestId === "r-second"
      )
    );

    // The ORPHANED first turn's stream finally throws for real — reached
    // directly through generation 0's controls, since the top-level
    // crash/feed/end now target generation 1 (the second send()).
    puppet.turn(0)?.crash(new Error("orphaned stream finally failed"));
    // Give the orphaned pump every chance to wrongly process this — if the
    // identity guards were missing, this would append a phantom
    // turn-done{turnId:"stream"} and deny r-second here.
    for (let i = 0; i < 30; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: draining, see settleUntil above
      await vi.advanceTimersByTimeAsync(10);
    }

    const history = await readHistory(WT);
    expect(
      history.filter((e) => e.kind === "turn-done" && e.turnId === "stream")
    ).toHaveLength(0);
    expect(verdict).toBeNull();
    expect(
      history.some(
        (e) => e.kind === "permission-resolved" && e.requestId === "r-second"
      )
    ).toBe(false);

    // Clean up: the permission is genuinely still answerable, and turn 2
    // finishes normally.
    expect(respondPermission(WT, "r-second", true)).toBe(true);
    await settleUntil(async () =>
      (await readHistory(WT)).some(
        (e) => e.kind === "permission-resolved" && e.requestId === "r-second"
      )
    );
    expect(verdict).toBe(true);
    puppet.feed({
      costUsd: null,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "t2",
      usage: null,
    });
    puppet.end();
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
    // The second send() below reads sessionId back through loadRegistry —
    // poll the registry file itself (a separate fs write chain from the
    // transcript's) rather than a fixed budget, so a slow persistIds()
    // write under load cannot leave the second send() reading a stale
    // (still-null) sessionId.
    await settleUntil(
      async () =>
        (await loadRegistry(base)).worktrees[WT]?.sessionId === "sess-42"
    );

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
    // tsc (strict null checks) reports TS2531 without this `?.`; puppet.input()
    // is typed StartTurnInput | null and biome's cross-module inference
    // disagrees with tsc here — trust tsc.
    // biome-ignore lint/suspicious/noUnnecessaryConditions: see above
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
    // Drain the denial's permission-resolved emit (real fs I/O) before the
    // test ends, so it cannot resolve after afterEach() nulls out baseDir.
    await settleUntil(async () =>
      (await readHistory(WT)).some(
        (e) => e.kind === "permission-resolved" && e.requestId === "r3"
      )
    );
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
    // tsc (strict null checks) reports TS2531 without this `?.`; puppet.input()
    // is typed StartTurnInput | null and biome's cross-module inference
    // disagrees with tsc here — trust tsc.
    // biome-ignore lint/suspicious/noUnnecessaryConditions: see above
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
    // Drain the denial's permission-resolved emit (real fs I/O) before the
    // test ends, so it cannot resolve after afterEach() nulls out baseDir.
    await settleUntil(async () =>
      (await readHistory(WT)).some(
        (e) => e.kind === "permission-resolved" && e.requestId === "r4"
      )
    );
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
    // tsc (strict null checks) reports TS2531 without this `?.`; puppet.input()
    // is typed StartTurnInput | null and biome's cross-module inference
    // disagrees with tsc here — trust tsc.
    // biome-ignore lint/suspicious/noUnnecessaryConditions: see above
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
    // permission-resolved is chained after the crash path's turn-done on
    // this worktree's serial emit chain (both queue through enqueueEmit, in
    // that order — see manager.ts's stream-error catch/finally), so polling
    // for it guarantees both land before the assertions below read history.
    // A fixed round budget flaked here under full-suite load: it could
    // return before the pump's catch/finally settled, racing afterEach's
    // baseDir reset against an in-flight transcript write.
    await settleUntil(async () =>
      (await readHistory(WT)).some(
        (e) => e.kind === "permission-resolved" && e.requestId === "r5"
      )
    );
    expect(verdict).toBe(false);

    // The crash's turn-done and the denial's permission-resolved both land —
    // denyPendingPermissions now emits, so this is no longer the last event.
    const history = await readHistory(WT);
    expect(
      history.some((e) => e.kind === "turn-done" && e.stopReason === "error")
    ).toBe(true);
    expect(
      history.some(
        (e) =>
          e.kind === "permission-resolved" &&
          e.requestId === "r5" &&
          e.approved === false
      )
    ).toBe(true);
  });

  // --- Increment 2, Task 3: prepareInheritance + consume-on-first-send.
  test("prepare(brief) then first send prefixes the brief, clears pending, and records inherited in the registry", async () => {
    const puppet = puppetDriver();
    configureManager({
      baseDir: base,
      drivers: { "claude-code": puppet.driver },
    });
    const PARENT_WT = "/wt/feat-parent";
    const CHILD_WT = "/wt/feat-child";

    await setConfig(PARENT_WT, {
      driverId: "claude-code",
      tier: "accept-edits",
    });
    await send(PARENT_WT, "Add retry logic to the sync engine.");
    puppet.feed({ kind: "turn-started", turnId: "p1" });
    puppet.feed({ kind: "text-delta", text: "Added retries." });
    puppet.feed({
      costUsd: 0.1,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "p1",
      usage: null,
    });
    puppet.end();
    await settleUntil(async () =>
      (await readHistory(PARENT_WT)).some((e) => e.kind === "turn-done")
    );

    const prepared = await prepareInheritance({
      childWorktree: CHILD_WT,
      mode: "brief",
      parentLabel: "feat/parent",
      parentWorktree: PARENT_WT,
    });
    expect(prepared.ok).toBe(true);
    expect(await readPendingInheritance(base, CHILD_WT)).not.toBeNull();

    expect((await send(CHILD_WT, "Please continue.")).accepted).toBe(true);
    const prompt = puppet.input()?.prompt ?? "";
    // Starts with the brief (its heading names the parent label)...
    expect(prompt.startsWith("# feat/parent")).toBe(true);
    expect(prompt).toContain("Add retry logic to the sync engine.");
    // ...and ends with the user's own text behind the contract's separator.
    expect(prompt.endsWith("\n\n---\n\nPlease continue.")).toBe(true);

    // Consumed exactly once: the pending file is gone after the turn started.
    expect(await readPendingInheritance(base, CHILD_WT)).toBeNull();
    const registry = await loadRegistry(base);
    expect(registry.worktrees[CHILD_WT]).toMatchObject({
      // Config follows the PARENT's entry so the fork lands on the same vendor.
      driverId: "claude-code",
      // parentLabel round-trips too — the badge must never have to
      // reverse-engineer a branch name from `from`, which is a worktree path.
      inherited: { from: PARENT_WT, mode: "brief", parentLabel: "feat/parent" },
      tier: "accept-edits",
    });

    puppet.feed({
      costUsd: null,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "c1",
      usage: null,
    });
    puppet.end();
  });

  // --- Final-review A3: the fork carries the parent's entire session
  // verbatim but runs from the child's cwd, so the mapping note must reach
  // it as a prompt prefix — it used to be dropped entirely on this branch.
  test("prepare(full) with a parent session forks claude-code's resume and prefixes the mapping note", async () => {
    const puppet = puppetDriver();
    configureManager({
      baseDir: base,
      drivers: { "claude-code": puppet.driver },
    });
    const PARENT_WT = "/wt/feat-parent-2";
    const CHILD_WT = "/wt/feat-child-2";

    await setConfig(PARENT_WT, {
      driverId: "claude-code",
      tier: "accept-edits",
    });
    await send(PARENT_WT, "Add retry logic to the sync engine.");
    puppet.input()?.onSessionId("parent-s1");
    puppet.feed({
      costUsd: null,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "p1",
      usage: null,
    });
    puppet.end();
    // persistIds's registry write is a separate fs chain from the
    // transcript's — poll it directly (mirrors the "session ids persist"
    // test above) so prepareInheritance cannot read a stale sessionId.
    await settleUntil(
      async () =>
        (await loadRegistry(base)).worktrees[PARENT_WT]?.sessionId ===
        "parent-s1"
    );

    const prepared = await prepareInheritance({
      childWorktree: CHILD_WT,
      mode: "full",
      parentLabel: "feat/parent-2",
      parentWorktree: PARENT_WT,
    });
    expect(prepared.ok).toBe(true);
    expect(
      (await loadRegistry(base)).worktrees[CHILD_WT]?.inherited?.mode
    ).toBe("full");

    expect((await send(CHILD_WT, "Please continue.")).accepted).toBe(true);
    expect(puppet.input()?.resume).toEqual({
      fork: true,
      sessionId: "parent-s1",
      threadId: null,
    });
    const prompt = puppet.input()?.prompt ?? "";
    expect(prompt.startsWith("The working directory changed from")).toBe(true);
    expect(prompt).toContain(PARENT_WT);
    expect(prompt).toContain(CHILD_WT);
    expect(prompt.endsWith("\n\n---\n\nPlease continue.")).toBe(true);
    // The fork branch carries history through cc's own session, not inject.
    expect(puppet.input()?.inject).toBeUndefined();

    puppet.feed({
      costUsd: null,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "c1",
      usage: null,
    });
    puppet.end();
  });

  // --- Final-review A1 (Critical): `inject` only reaches a driver that
  // consumes it (codex's thread/inject_items) — the claude adapter reads
  // `resume` only and silently drops `inject`. Reachable without exotic
  // timing whenever a full-tier pending has no parentSessionId on a
  // claude-code child (parent ran codex, its entry is missing, or — as
  // here — its session id was simply never announced before the child
  // inherits): prepareInheritance still copies the parent's driverId
  // ("claude-code") onto the child, so the fork precondition
  // (`entry.driverId === "claude-code" && pending.parentSessionId`) fails
  // on the sessionId half only. Before the fix this fell through to
  // `inject`, which the claude adapter ignores — the badge would claim
  // `mode: "full"` while the child inherited nothing.
  test("full mode with no parentSessionId on a claude-code child degrades to a prompt prefix, never inject", async () => {
    const puppet = puppetDriver();
    configureManager({
      baseDir: base,
      drivers: { "claude-code": puppet.driver },
    });
    const PARENT_WT = "/wt/feat-parent-nosession";
    const CHILD_WT = "/wt/feat-child-nosession";

    await setConfig(PARENT_WT, {
      driverId: "claude-code",
      tier: "accept-edits",
    });
    await send(PARENT_WT, "Add retry logic to the sync engine.");
    puppet.feed({ kind: "turn-started", turnId: "p1" });
    puppet.feed({ kind: "text-delta", text: "Added retries." });
    puppet.feed({
      costUsd: 0.1,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "p1",
      usage: null,
    });
    puppet.end();
    // No onSessionId call above: the parent's registry entry keeps
    // sessionId: null, so prepareInheritance writes a full-mode pending with
    // no parentSessionId even though the parent's driver is claude-code.
    await settleUntil(async () =>
      (await readHistory(PARENT_WT)).some((e) => e.kind === "turn-done")
    );
    expect(
      (await loadRegistry(base)).worktrees[PARENT_WT]?.sessionId
    ).toBeNull();

    const prepared = await prepareInheritance({
      childWorktree: CHILD_WT,
      mode: "full",
      parentLabel: "feat/parent-nosession",
      parentWorktree: PARENT_WT,
    });
    expect(prepared.ok).toBe(true);
    // Config follows the parent, so the child is claude-code too — the fork
    // precondition's driver half is satisfied; only sessionId is missing.
    expect((await loadRegistry(base)).worktrees[CHILD_WT]?.driverId).toBe(
      "claude-code"
    );

    expect((await send(CHILD_WT, "Please continue.")).accepted).toBe(true);
    const input = puppet.input();
    expect(input?.inject).toBeUndefined();
    // The fork precondition never engaged: no `fork` key at all, sessionId
    // and threadId are the CHILD's own (both still null, its first turn).
    expect(input?.resume).toEqual({ sessionId: null, threadId: null });
    const prompt = input?.prompt ?? "";
    expect(prompt.startsWith("The working directory changed from")).toBe(true);
    expect(prompt).toContain("user: Add retry logic to the sync engine.");
    expect(prompt).toContain("assistant: Added retries.");
    expect(prompt.endsWith("\n\n---\n\nPlease continue.")).toBe(true);

    puppet.feed({
      costUsd: null,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "c1",
      usage: null,
    });
    puppet.end();
  });

  test("prepare refuses when the parent transcript has no conversation, writing nothing", async () => {
    const puppet = puppetDriver();
    configureManager({
      baseDir: base,
      drivers: { "claude-code": puppet.driver },
    });
    const PARENT_WT = "/wt/feat-empty-parent";
    const CHILD_WT = "/wt/feat-child-3";

    const result = await prepareInheritance({
      childWorktree: CHILD_WT,
      mode: "brief",
      parentLabel: "feat/empty-parent",
      parentWorktree: PARENT_WT,
    });
    expect(result).toEqual({
      ok: false,
      reason: "The parent has no conversation to inherit.",
    });

    expect(await readPendingInheritance(base, CHILD_WT)).toBeNull();
    const registry = await loadRegistry(base);
    expect(registry.worktrees[CHILD_WT]).toBeUndefined();
  });

  // --- Review finding: prepareInheritance's two writes were not atomic as a
  // pair (pending file first, registry entry second). A send() racing in
  // between could read the pending payload while the registry entry was
  // still missing — silently downgrading a claude-code full inheritance to
  // the inject path, and (via send's own `!entry` setConfig fallback)
  // risking clobbering the entry's `inherited` field once it did land.
  // Fixed by writing the registry FIRST: a racing send() can then only ever
  // observe "entry, no pending yet" (an ordinary fresh turn — fine) or
  // "entry with pending" (fully offered) — never "pending without entry".
  test("prepareInheritance racing an immediate send() never applies the brief without the registry recording inherited", async () => {
    const puppet = puppetDriver();
    configureManager({
      baseDir: base,
      drivers: { "claude-code": puppet.driver },
    });
    const PARENT_WT = "/wt/feat-parent-race";
    const CHILD_WT = "/wt/feat-child-race";

    await setConfig(PARENT_WT, {
      driverId: "claude-code",
      tier: "accept-edits",
    });
    await send(PARENT_WT, "Add retry logic to the sync engine.");
    puppet.feed({
      costUsd: null,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "p1",
      usage: null,
    });
    puppet.end();
    await settleUntil(async () =>
      (await readHistory(PARENT_WT)).some((e) => e.kind === "turn-done")
    );

    // No settle between prepare and send: races prepareInheritance's two
    // writes against send()'s own registry+pending reads as tightly as this
    // test can manage. CHILD_WT has never been configured, so send() also
    // exercises its own `!entry` setConfig fallback concurrently.
    const [prepared, sent] = await Promise.all([
      prepareInheritance({
        childWorktree: CHILD_WT,
        mode: "brief",
        parentLabel: "feat/parent-race",
        parentWorktree: PARENT_WT,
      }),
      send(CHILD_WT, "Please continue."),
    ]);
    expect(prepared.ok).toBe(true);
    expect(sent.accepted).toBe(true);

    // Both promises above are fully resolved already — prepareInheritance's
    // own writes (registry, then pending) completed inside its own awaited
    // body, and send()'s own decision (whatever it read mid-race) is baked
    // into whatever it handed the driver. Poll the transcript purely for
    // hygiene (draining the user-message write before teardown), not
    // because the checks below need it to settle further.
    await settleUntil(async () =>
      (await readHistory(CHILD_WT)).some((e) => e.kind === "user-message")
    );

    const prompt = puppet.input()?.prompt ?? "";
    const briefApplied = prompt.includes("Add retry logic to the sync engine.");
    const registry = await loadRegistry(base);
    const inheritedRecorded =
      registry.worktrees[CHILD_WT]?.inherited?.mode === "brief";

    // The one outcome the write-ordering fix must rule out: a turn that got
    // the brief from a pending file whose registry-side `inherited` record
    // hadn't landed (or got clobbered by this same send()'s own setConfig
    // fallback). "entry exists, pending doesn't yet" — brief not applied —
    // is fine and expected some of the time; "pending exists, entry
    // doesn't" must be impossible, in the final state as well as in transit.
    if (briefApplied) {
      expect(inheritedRecorded).toBe(true);
    }

    puppet.feed({
      costUsd: null,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "c1",
      usage: null,
    });
    puppet.end();
  });

  // --- Same review finding as above, verified more directly: a
  // Promise.all race against a single send() depends on lucky timing to
  // ever land inside the narrow window between prepareInheritance's two
  // writes (confirmed empirically: reverting the write-order fix did not
  // make the test above fail across 25 runs). This test instead samples
  // on-disk state repeatedly WHILE prepareInheritance is still in flight,
  // which reliably lands inside that window (reverting the fix reliably
  // fails this test) — the direct, deterministic check that the pending
  // file is never observable before the registry entry it depends on.
  test("prepareInheritance never makes the pending file observable before its registry entry lands", async () => {
    const puppet = puppetDriver();
    configureManager({
      baseDir: base,
      drivers: { "claude-code": puppet.driver },
    });
    const PARENT_WT = "/wt/feat-parent-order";
    const CHILD_WT = "/wt/feat-child-order";

    await setConfig(PARENT_WT, {
      driverId: "claude-code",
      tier: "accept-edits",
    });
    await send(PARENT_WT, "Add retry logic to the sync engine.");
    puppet.feed({
      costUsd: null,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "p1",
      usage: null,
    });
    puppet.end();
    await settleUntil(async () =>
      (await readHistory(PARENT_WT)).some((e) => e.kind === "turn-done")
    );

    const preparePromise = prepareInheritance({
      childWorktree: CHILD_WT,
      mode: "brief",
      parentLabel: "feat/parent-order",
      parentWorktree: PARENT_WT,
    });

    // No fake-timer advancement needed: nothing in prepareInheritance's path
    // uses setTimeout, so a tight loop of real fs reads races its real fs
    // writes directly. observedPending asserts this loop actually caught
    // the payload mid-flight at least once — otherwise a "no bad window
    // seen" result would be meaningless (the loop finished before prepare
    // even started writing).
    let observedPending = false;
    let observedPendingWithoutEntry = false;
    for (let i = 0; i < 500; i += 1) {
      // Sequential by nature: this is a temporal poll racing prepare's real
      // fs writes — each sample must land before the next fires, spreading
      // the reads across prepare's actual progress. Promise.all across
      // iterations would collapse them into one snapshot at time zero,
      // defeating the poll entirely.
      // biome-ignore lint/performance/noAwaitInLoops: see above
      const [pending, registry] = await Promise.all([
        readPendingInheritance(base, CHILD_WT),
        loadRegistry(base),
      ]);
      if (pending) {
        observedPending = true;
        if (registry.worktrees[CHILD_WT]?.inherited?.mode !== "brief") {
          observedPendingWithoutEntry = true;
        }
      }
    }
    await preparePromise;

    expect(observedPending).toBe(true);
    expect(observedPendingWithoutEntry).toBe(false);
  });

  // --- Controller's real-CLI acceptance smoke deterministically confirmed
  // the residual flagged in the prior fix round: setConfig's object literal
  // fully replaces the registry entry, so ANY setConfig call after
  // prepareInheritance — the config bar in product, the smoke's own tier
  // call — permanently erased the `inherited` badge/provenance record.
  test("setConfig after prepareInheritance keeps the inherited record intact", async () => {
    const puppet = puppetDriver();
    configureManager({
      baseDir: base,
      drivers: { "claude-code": puppet.driver },
    });
    const PARENT_WT = "/wt/feat-parent-provenance";
    const CHILD_WT = "/wt/feat-child-provenance";

    await setConfig(PARENT_WT, {
      driverId: "claude-code",
      tier: "accept-edits",
    });
    await send(PARENT_WT, "Add retry logic to the sync engine.");
    puppet.feed({
      costUsd: null,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "p1",
      usage: null,
    });
    puppet.end();
    await settleUntil(async () =>
      (await readHistory(PARENT_WT)).some((e) => e.kind === "turn-done")
    );

    const prepared = await prepareInheritance({
      childWorktree: CHILD_WT,
      mode: "brief",
      parentLabel: "feat/parent-provenance",
      parentWorktree: PARENT_WT,
    });
    expect(prepared.ok).toBe(true);

    // A different driver AND tier, so the assertion below can only pass if
    // the new config actually applied — not just that inherited survived.
    await setConfig(CHILD_WT, { driverId: "codex", tier: "yolo" });

    const registry = await loadRegistry(base);
    expect(registry.worktrees[CHILD_WT]).toMatchObject({
      driverId: "codex",
      inherited: {
        from: PARENT_WT,
        mode: "brief",
        parentLabel: "feat/parent-provenance",
      },
      tier: "yolo",
    });
  });
});
