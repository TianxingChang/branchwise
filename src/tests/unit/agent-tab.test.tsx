import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import AgentTab from "@/components/panel/agent-tab";
import type { ConversationItem } from "@/lib/agent/fold";
import { emptyConversation } from "@/lib/agent/fold";
import { _setAgentActionsForTests, useAgentStore } from "@/stores/agent-store";

// The DiffStrip's fetch hangs deliberately (same no-act-noise discipline as
// the agent actions below): these tests never assert on the strip, and
// agent-diff-strip.test.tsx covers it against a resolving mock.
vi.mock("@/actions/repo", () => ({
  worktreeDiffSummary: () => new Promise(() => undefined),
}));

const WT = "/wt/feat-a";
const APPROVE_BUTTON_NAME = /approve/i;
const DENY_BUTTON_NAME = /deny/i;
const INTERRUPT_BUTTON_NAME = /interrupt/i;
const AGENT_BACKEND_LABEL = /agent backend/i;

// A promise that intentionally never settles, matching attachAgent's
// existing "never yields, never ends" fake stream below: every test in this
// file seeds the session's config/conversation directly via seedSession()
// and asserts against that seeded state, never against what open() would
// itself fetch. Letting getAgentConfig/agentHistory resolve would race that
// fetch's own patch() against the test body — landing, unawaited, after the
// synchronous assertions already ran — and produce an act() warning for a
// value no test reads. Hanging them is a no-op for coverage (agent-store.test.ts
// already exercises the real resolve path) and removes the race at its root.
function neverSettles<T>(): Promise<T> {
  // biome-ignore lint/suspicious/noEmptyBlockStatements: deliberately never resolves; see comment above.
  return new Promise(() => {});
}

function stubActions() {
  const respond = vi.fn(() => Promise.resolve({ ok: true }));
  _setAgentActionsForTests({
    agentHistory: () => neverSettles(),
    attachAgent: () =>
      Promise.resolve(
        (async function* () {
          // never yields, never ends
          // biome-ignore lint/suspicious/noEmptyBlockStatements: the executor deliberately never settles so the fake stream hangs open.
          await new Promise(() => {});
        })()
      ),
    getAgentConfig: () => neverSettles(),
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
  items?: ConversationItem[];
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
  if (overrides.items) {
    conversation.items = overrides.items;
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
  // @testing-library/react's own auto-cleanup afterEach is registered lazily
  // (on first render(), not on import), which puts it *after* this hook in
  // registration order — so without an explicit call here, reset() below
  // fires against a still-mounted, still-subscribed AgentTab and React logs
  // an act() warning for a component about to be torn down anyway. Calling
  // cleanup() first makes the unmount (and its close() effect cleanup)
  // deterministic before store teardown runs.
  cleanup();
  useAgentStore.getState().reset();
});

describe("AgentTab", () => {
  test("permission card approve/deny call respond with the request id", () => {
    const { respond } = stubActions();
    seedSession({ activeTurnId: "t1", pendingPermission: true });
    render(<AgentTab branchLabel="feat-a" head="h1" parentBranch={null} projectFolder="/project" worktreePath={WT} />);
    fireEvent.click(screen.getByRole("button", { name: APPROVE_BUTTON_NAME }));
    expect(respond).toHaveBeenCalledWith({
      approved: true,
      requestId: "r1",
      worktreePath: WT,
    });
  });

  test("permission card deny calls respond with approved:false", () => {
    const { respond } = stubActions();
    seedSession({ activeTurnId: "t1", pendingPermission: true });
    render(<AgentTab branchLabel="feat-a" head="h1" parentBranch={null} projectFolder="/project" worktreePath={WT} />);
    fireEvent.click(screen.getByRole("button", { name: DENY_BUTTON_NAME }));
    expect(respond).toHaveBeenCalledWith({
      approved: false,
      requestId: "r1",
      worktreePath: WT,
    });
  });

  test("composer is disabled while a turn is active, interrupt appears", () => {
    stubActions();
    seedSession({ activeTurnId: "t1" });
    render(<AgentTab branchLabel="feat-a" head="h1" parentBranch={null} projectFolder="/project" worktreePath={WT} />);
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: INTERRUPT_BUTTON_NAME })
    ).toBeInTheDocument();
  });

  test("driver picker locks once a conversation exists", () => {
    stubActions();
    seedSession({ hasConversation: true });
    render(<AgentTab branchLabel="feat-a" head="h1" parentBranch={null} projectFolder="/project" worktreePath={WT} />);
    expect(screen.getByLabelText(AGENT_BACKEND_LABEL)).toBeDisabled();
  });

  test("cost line stays on the last assistant reply after a new user message", () => {
    stubActions();
    seedSession({
      hasConversation: true,
      items: [
        {
          costUsd: 0.37,
          id: "turn-t0",
          kind: "assistant",
          stopReason: "completed",
          text: "done",
          thinking: "",
          usage: null,
        },
        { id: "i1", kind: "user", text: "next" },
      ],
    });
    render(<AgentTab branchLabel="feat-a" head="h1" parentBranch={null} projectFolder="/project" worktreePath={WT} />);
    expect(screen.getByText("≈ $0.37")).toBeInTheDocument();
  });
});
