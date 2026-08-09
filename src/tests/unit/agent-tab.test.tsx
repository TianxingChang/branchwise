import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import AgentTab from "@/components/panel/agent-tab";
import { emptyConversation } from "@/lib/agent/fold";
import { _setAgentActionsForTests, useAgentStore } from "@/stores/agent-store";
import type { AgentEvent } from "@/types/agent";

const WT = "/wt/feat-a";
const APPROVE_BUTTON_NAME = /approve/i;
const INTERRUPT_BUTTON_NAME = /interrupt/i;
const AGENT_BACKEND_LABEL = /agent backend/i;

function stubActions() {
  const respond = vi.fn(() => Promise.resolve({ ok: true }));
  _setAgentActionsForTests({
    agentHistory: () => Promise.resolve([] as AgentEvent[]),
    attachAgent: () =>
      Promise.resolve(
        (async function* () {
          // never yields, never ends
          // biome-ignore lint/suspicious/noEmptyBlockStatements: the executor deliberately never settles so the fake stream hangs open.
          await new Promise(() => {});
        })()
      ),
    getAgentConfig: () =>
      Promise.resolve({
        config: {
          driverId: "claude-code" as const,
          tier: "accept-edits" as const,
        },
        hasConversation: false,
        turnActive: false,
      }),
    interruptAgent: () => Promise.resolve({ ok: true as const }),
    respondAgentPermission: respond,
    sendAgentMessage: () => Promise.resolve({ accepted: true }),
    setAgentConfig: () => Promise.resolve({ ok: true as const }),
  });
  return { respond };
}

function seedSession(overrides: {
  activeTurnId?: string | null;
  hasConversation?: boolean;
  pendingPermission?: boolean;
}) {
  const conversation = emptyConversation();
  conversation.activeTurnId = overrides.activeTurnId ?? null;
  if (overrides.pendingPermission) {
    conversation.items = [
      {
        detail: "rm -rf build",
        id: "perm-r1",
        kind: "permission",
        requestId: "r1",
        state: "pending",
        toolName: "Bash",
      },
    ];
  }
  useAgentStore.setState({
    sessions: {
      [WT]: {
        attached: true,
        config: { driverId: "claude-code", tier: "accept-edits" },
        conversation,
        hasConversation: overrides.hasConversation ?? false,
      },
    },
  });
}

afterEach(() => {
  useAgentStore.getState().reset();
});

describe("AgentTab", () => {
  test("permission card approve/deny call respond with the request id", () => {
    const { respond } = stubActions();
    seedSession({ activeTurnId: "t1", pendingPermission: true });
    render(<AgentTab branchLabel="feat-a" worktreePath={WT} />);
    fireEvent.click(screen.getByRole("button", { name: APPROVE_BUTTON_NAME }));
    expect(respond).toHaveBeenCalledWith({
      approved: true,
      requestId: "r1",
      worktreePath: WT,
    });
  });

  test("composer is disabled while a turn is active, interrupt appears", () => {
    stubActions();
    seedSession({ activeTurnId: "t1" });
    render(<AgentTab branchLabel="feat-a" worktreePath={WT} />);
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: INTERRUPT_BUTTON_NAME })
    ).toBeInTheDocument();
  });

  test("driver picker locks once a conversation exists", () => {
    stubActions();
    seedSession({ hasConversation: true });
    render(<AgentTab branchLabel="feat-a" worktreePath={WT} />);
    expect(screen.getByLabelText(AGENT_BACKEND_LABEL)).toBeDisabled();
  });
});
