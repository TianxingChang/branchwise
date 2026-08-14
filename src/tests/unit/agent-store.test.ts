import { afterEach, describe, expect, test } from "vitest";
import type { AgentTarget } from "@/actions/agent";
import {
  _setAgentActionsForTests,
  agentActivity,
  selectSession,
  useAgentStore,
} from "@/stores/agent-store";
import type { AgentEvent } from "@/types/agent";

const WT = "/wt/feat-a";
/** The conversation every worktree has always had. */
const TARGET = { conversationId: "1", worktreePath: WT };

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
    agentHistory: (_target: AgentTarget) => Promise.resolve(history),
    attachAgent: (_target: AgentTarget, signal: AbortSignal) =>
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
    getAgentConfig: (_target: AgentTarget) =>
      Promise.resolve({
        config: {
          driverId: "claude-code" as const,
          tier: "accept-edits" as const,
        },
        hasConversation: history.length > 0,
        inherited: null,
        turnActive: false,
      }),
    interruptAgent: (target: AgentTarget) => {
      calls.interrupt.push(target);
      return Promise.resolve({ ok: true as const });
    },
    respondAgentPermission: (input: unknown) => {
      calls.respond.push(input);
      return Promise.resolve({ ok: true });
    },
    sendAgentMessage: (target: AgentTarget, text: string) => {
      calls.send.push([target, text]);
      return Promise.resolve({ accepted: true });
    },
    setAgentConfig: (target: AgentTarget, config: unknown) => {
      calls.setConfig.push([target, config]);
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

    await useAgentStore.getState().open(TARGET);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const session = selectSession(useAgentStore.getState(), TARGET);
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
    await useAgentStore.getState().open(TARGET);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(
      agentActivity(selectSession(useAgentStore.getState(), TARGET))
    ).toEqual({
      needsPermission: true,
      running: true,
    });

    await useAgentStore.getState().respond(TARGET, "r1", true);
    expect(fake.calls.respond).toEqual([
      {
        approved: true,
        conversationId: "1",
        requestId: "r1",
        worktreePath: WT,
      },
    ]);
    fake.end();
  });

  test("sendMessage delegates and close aborts the live stream", async () => {
    const fake = fakeActions([], []);
    _setAgentActionsForTests(fake.actions);
    await useAgentStore.getState().open(TARGET);
    await useAgentStore.getState().sendMessage(TARGET, "do it");
    expect(fake.calls.send).toEqual([[TARGET, "do it"]]);
    useAgentStore.getState().close(TARGET);
    expect(selectSession(useAgentStore.getState(), TARGET).attached).toBe(
      false
    );
  });
});
