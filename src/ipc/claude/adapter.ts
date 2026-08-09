import { randomUUID } from "node:crypto";
import type {
  AgentDriver,
  AgentTurnHandle,
  StartTurnInput,
} from "@/ipc/agent/driver";
import type { AgentEvent } from "@/types/agent";
import { resolveClaudeExecutable } from "./executable";
import { mapClaudeMessage } from "./map-events";
import { buildClaudeOptions, type CanUseToolShim } from "./options";

export type ClaudeQueryFactory = (params: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<unknown>;

async function defaultQueryFactory(params: {
  prompt: string;
  options: Record<string, unknown>;
}): Promise<AsyncIterable<unknown>> {
  // The only place the vendor SDK is imported. Lazy so the main bundle does
  // not pay for it until an agent actually runs.
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return sdk.query(params as never);
}

const INSTALL_HINT =
  "Claude Code is not installed (or not on PATH). Install it from https://claude.com/claude-code, or set CLAUDE_BIN to the binary.";

export function createClaudeDriver(dependencies?: {
  queryFactory?: ClaudeQueryFactory;
  resolveExecutable?: () => Promise<string | null>;
}): AgentDriver {
  const resolve =
    dependencies?.resolveExecutable ?? (() => resolveClaudeExecutable());
  const factory: ClaudeQueryFactory | undefined = dependencies?.queryFactory;

  function startTurn(input: StartTurnInput): AgentTurnHandle {
    const controller = new AbortController();
    const turnId = randomUUID();
    let sawResult = false;
    let sessionAnnounced = false;

    const canUseTool: CanUseToolShim = async (toolName, toolInput) => {
      const approved = await input.requestPermission({
        detail: summarize(toolInput),
        requestId: randomUUID(),
        toolName,
      });
      return approved
        ? { behavior: "allow" }
        : { behavior: "deny", message: "Denied from the branchwise panel." };
    };

    function* processMessage(
      message: unknown
    ): Generator<AgentEvent, void, unknown> {
      if (!sessionAnnounced) {
        const sessionId = (message as { session_id?: unknown }).session_id;
        if (typeof sessionId === "string" && sessionId.length > 0) {
          sessionAnnounced = true;
          input.onSessionId(sessionId);
        }
      }
      for (const event of mapClaudeMessage(message, turnId)) {
        if (event.kind === "turn-done") {
          sawResult = true;
        }
        yield event;
      }
    }

    async function* streamEvents(
      options: Record<string, unknown>
    ): AsyncGenerator<AgentEvent> {
      try {
        const stream = factory
          ? factory({ options, prompt: input.prompt })
          : await defaultQueryFactory({ options, prompt: input.prompt });

        for await (const message of stream) {
          yield* processMessage(message);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          yield {
            kind: "error",
            message:
              error instanceof Error ? error.message : "The Claude run failed.",
          };
          yield done("error");
        }
      }
    }

    async function* events(): AsyncGenerator<AgentEvent> {
      yield { kind: "turn-started", turnId };

      const executable = await resolve();
      if (!executable) {
        yield { kind: "error", message: INSTALL_HINT };
        yield done("error");
        return;
      }

      const options = buildClaudeOptions({
        abortController: controller,
        canUseTool,
        executable,
        resumeSessionId: input.resume.sessionId,
        tier: input.tier,
        worktreePath: input.worktreePath,
      });

      yield* streamEvents(options);

      if (!sawResult) {
        yield done(controller.signal.aborted ? "interrupted" : "completed");
      }
    }

    function done(
      stopReason: "completed" | "interrupted" | "error"
    ): AgentEvent {
      sawResult = true;
      return {
        costUsd: null,
        kind: "turn-done",
        stopReason,
        turnId,
        usage: null,
      };
    }

    return {
      events: events(),
      interrupt: () => {
        controller.abort();
        return Promise.resolve();
      },
    };
  }

  return {
    id: "claude-code",
    shutdown: () => Promise.resolve(),
    startTurn,
  };
}

function summarize(input: Record<string, unknown>): string {
  for (const key of ["command", "file_path", "path", "url"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      return value.length > 200 ? `${value.slice(0, 200)}…` : value;
    }
  }
  const json = JSON.stringify(input);
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
}
