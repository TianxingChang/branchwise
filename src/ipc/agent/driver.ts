import type { AgentDriverId, AgentEvent, PermissionTier } from "@/types/agent";

export interface StartTurnInput {
  worktreePath: string;
  prompt: string;
  tier: PermissionTier;
  resume: { sessionId: string | null; threadId: string | null };
  /** Called the moment the vendor announces a session id — before any output. */
  onSessionId: (id: string) => void;
  onThreadId: (id: string) => void;
  /**
   * The manager parks the returned promise until the user answers from the
   * panel; the adapter awaits it and translates the boolean into its vendor's
   * verdict shape.
   */
  requestPermission: (request: {
    requestId: string;
    toolName: string;
    detail: string;
  }) => Promise<boolean>;
}

export interface AgentTurnHandle {
  events: AsyncIterable<AgentEvent>;
  interrupt: () => Promise<void>;
}

export interface AgentDriver {
  id: AgentDriverId;
  /** Kill children and drop per-process state. Called on app quit. */
  shutdown: () => Promise<void>;
  startTurn: (input: StartTurnInput) => AgentTurnHandle;
}

export class AgentDriverError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentDriverError";
  }
}
