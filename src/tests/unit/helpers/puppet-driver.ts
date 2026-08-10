import type { AgentDriver, StartTurnInput } from "@/ipc/agent/driver";
import type { AgentEvent } from "@/types/agent";

/** Hand-fed controls for one startTurn() generation. */
interface TurnControls {
  crash: (error: Error) => void;
  end: () => void;
  feed: (event: AgentEvent) => void;
  input: StartTurnInput;
}

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
  // One entry per startTurn() call, oldest first — `crash`/`feed`/`end`
  // below always target the LATEST generation (matching every existing
  // test's assumption that there is exactly one live turn), but a second
  // send() on the same worktree reassigns them: reaching a PRIOR
  // generation's controls (e.g. to make an orphaned turn's stream throw
  // after a newer turn has already claimed the slot) needs `turn(index)`.
  const generations: TurnControls[] = [];
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
      // Bound to this generation specifically (not the outer mutable
      // push/raise) so interrupt() below always acts on the turn it was
      // returned for, even after a later startTurn() reassigns the outer
      // variables.
      const thisPush = (event: AgentEvent | null) => {
        buffered.push(event);
        wake?.();
        wake = null;
      };
      const thisRaise = (error: Error) => {
        pendingError = error;
        wake?.();
        wake = null;
      };
      push = thisPush;
      raise = thisRaise;
      generations.push({
        crash: thisRaise,
        end: () => thisPush(null),
        feed: thisPush,
        input,
      });
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
          thisPush({
            costUsd: null,
            kind: "turn-done",
            stopReason: "interrupted",
            turnId: "t1",
            usage: null,
          });
          thisPush(null);
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
    /** Prior (or current) generation's controls, oldest first, 0-indexed. */
    turn: (index: number): TurnControls | undefined => generations[index],
  };
}
