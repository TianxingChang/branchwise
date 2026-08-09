import type { AgentDriver, StartTurnInput } from "@/ipc/agent/driver";
import type { AgentEvent } from "@/types/agent";

/** A driver whose event stream the test hand-feeds. */
export function puppetDriver(
  id: "claude-code" | "codex" = "claude-code",
  options: {
    /**
     * A wedged-but-alive child: interrupt() acks (its promise resolves,
     * same as a real vendor's turn/interrupt RPC completing) but the event
     * stream never yields another event and never ends — simulating a
     * child that never sends turn/completed. Exercises the manager's
     * bounded grace/force-close, not the driver's own cooperative path.
     */
    wedgeInterrupt?: boolean;
  } = {}
) {
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
          if (options.wedgeInterrupt) {
            // Ack, and nothing else: the child accepted the interrupt
            // request but the stream never yields another event.
            return Promise.resolve();
          }
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
