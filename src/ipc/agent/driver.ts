import type { AgentDriverId, AgentEvent, PermissionTier } from "@/types/agent";

export interface StartTurnInput {
  /**
   * A parent conversation to seed into a FRESH session/thread before the
   * turn starts (codex thread/inject_items shape). Set by the manager when
   * consuming a full-tier inheritance that falls back to inject instead of a
   * claude-code fork — never alongside a resumed session/thread, which
   * already carries its own history. The adapters that read it land in
   * Task 4.
   */
  inject?: { role: "assistant" | "user"; text: string }[];
  /** Called the moment the vendor announces a session id — before any output. */
  onSessionId: (id: string) => void;
  onThreadId: (id: string) => void;
  prompt: string;
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
  resume: {
    sessionId: string | null;
    threadId: string | null;
    /**
     * Fork the resumed session into a new one rather than continuing it in
     * place (claude-code only). Set by the manager when consuming a
     * full-tier inheritance whose parent's driver is claude-code.
     */
    fork?: boolean;
  };
  tier: PermissionTier;
  worktreePath: string;
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
