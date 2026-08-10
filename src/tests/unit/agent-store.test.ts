import { afterEach, describe, expect, test } from "vitest";
import {
  _setAgentActionsForTests,
  agentActivity,
  selectSession,
  useAgentStore,
} from "@/stores/agent-store";
import type { AgentEvent } from "@/types/agent";

const WT = "/wt/feat-a";

/** A controllable fake of src/actions/agent.ts. */
function fakeActions(history: AgentEvent[], replayThenLive: AgentEvent[]) {
  const calls: Record<string, unknown[]> = {
    interrupt: [],
    respond: [],
    send: [],
    setConfig: [],
  };
  let releaseLive: (() => void) | null = null;
  const actions = {
    agentHistory: () => Promise.resolve(history),
    attachAgent: (_wt: string, signal: AbortSignal) =>
      Promise.resolve(
        (async function* () {
          for (const event of replayThenLive) {
            if (signal.aborted) {
              return;
            }
            yield event;
          }
          await new Promise<void>((resolve) => {
            releaseLive = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        })()
      ),
    getAgentConfig: () =>
      Promise.resolve({
        config: {
          driverId: "claude-code" as const,
          tier: "accept-edits" as const,
        },
        hasConversation: history.length > 0,
        inherited: null,
        turnActive: false,
      }),
    interruptAgent: (wt: string) => {
      calls.interrupt.push(wt);
      return Promise.resolve({ ok: true as const });
    },
    respondAgentPermission: (input: unknown) => {
      calls.respond.push(input);
      return Promise.resolve({ ok: true });
    },
    sendAgentMessage: (wt: string, text: string) => {
      calls.send.push([wt, text]);
      return Promise.resolve({ accepted: true });
    },
    setAgentConfig: (wt: string, config: unknown) => {
      calls.setConfig.push([wt, config]);
      return Promise.resolve({ ok: true as const });
    },
  };
  return { actions, calls, end: () => releaseLive?.() };
}

afterEach(() => {
  useAgentStore.getState().reset();
});

const DONE: AgentEvent = {
  costUsd: null,
  kind: "turn-done",
  stopReason: "completed",
  turnId: "t0",
  usage: null,
};

describe("agent store", () => {
  test("open folds history, trims the unfinished tail, then folds live events", async () => {
    // History ends mid-turn (user-message after the last turn-done); the
    // attach replay re-delivers that active turn, so the trim prevents the
    // duplicate user bubble.
    const history: AgentEvent[] = [
      { kind: "user-message", text: "first" },
      DONE,
      { kind: "user-message", text: "second" },
    ];
    const replay: AgentEvent[] = [
      { kind: "user-message", text: "second" },
      { kind: "turn-started", turnId: "t1" },
      { kind: "text-delta", text: "wor" },
    ];
    const fake = fakeActions(history, replay);
    _setAgentActionsForTests(fake.actions);

    await useAgentStore.getState().open(WT);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const session = selectSession(useAgentStore.getState(), WT);
    const userItems = session.conversation.items.filter(
      (item) => item.kind === "user"
    );
    expect(userItems.map((item) => item.kind === "user" && item.text)).toEqual([
      "first",
      "second",
    ]);
    expect(session.conversation.streamingText).toBe("wor");
    expect(agentActivity(session)).toEqual({
      needsPermission: false,
      running: true,
    });
    fake.end();
  });

  test("pending permission flips needsPermission; respond passes through", async () => {
    const fake = fakeActions(
      [],
      [
        { kind: "turn-started", turnId: "t1" },
        {
          detail: "npm test",
          kind: "permission-request",
          requestId: "r1",
          toolName: "Bash",
        },
      ]
    );
    _setAgentActionsForTests(fake.actions);
    await useAgentStore.getState().open(WT);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(agentActivity(selectSession(useAgentStore.getState(), WT))).toEqual({
      needsPermission: true,
      running: true,
    });

    await useAgentStore.getState().respond(WT, "r1", true);
    expect(fake.calls.respond).toEqual([
      { approved: true, requestId: "r1", worktreePath: WT },
    ]);
    fake.end();
  });

  test("sendMessage delegates and close aborts the live stream", async () => {
    const fake = fakeActions([], []);
    _setAgentActionsForTests(fake.actions);
    await useAgentStore.getState().open(WT);
    await useAgentStore.getState().sendMessage(WT, "do it");
    expect(fake.calls.send).toEqual([[WT, "do it"]]);
    useAgentStore.getState().close(WT);
    expect(selectSession(useAgentStore.getState(), WT).attached).toBe(false);
  });
});
