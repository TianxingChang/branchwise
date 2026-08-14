import { beforeEach, describe, expect, test } from "vitest";
import { conversationsOf, useAgentTabsStore } from "@/stores/agent-tabs-store";

const WT = "/repo/wt/feature";

function tabs(worktreePath = WT) {
  return conversationsOf(useAgentTabsStore.getState(), worktreePath);
}

describe("agent conversation tabs", () => {
  beforeEach(() => {
    useAgentTabsStore.setState({ byWorktree: {} });
  });

  test("a worktree starts with the conversation it has always had", () => {
    expect(tabs().ids).toEqual(["1"]);
    expect(tabs().activeId).toBe("1");
  });

  test("opening adds a conversation and shows it", () => {
    const id = useAgentTabsStore.getState().open(WT);

    expect(id).toBe("2");
    expect(tabs().ids).toEqual(["1", "2"]);
    expect(tabs().activeId).toBe("2");
  });

  test("never reissues the id of a closed conversation", () => {
    const store = useAgentTabsStore.getState();
    store.open(WT);
    useAgentTabsStore.getState().close(WT, "2");

    // Conversation 2's transcript is still on disk under that id. Handing the
    // id to a "new" conversation would open it onto somebody else's history.
    expect(useAgentTabsStore.getState().open(WT)).toBe("3");
  });

  test("closing the visible conversation shows its neighbour", () => {
    const store = useAgentTabsStore.getState();
    store.open(WT);
    store.open(WT);
    useAgentTabsStore.getState().focus(WT, "2");

    useAgentTabsStore.getState().close(WT, "2");

    expect(tabs().ids).toEqual(["1", "3"]);
    expect(tabs().activeId).toBe("3");
  });

  test("refuses to close the last conversation", () => {
    // The first one owns the history every branch already had.
    useAgentTabsStore.getState().close(WT, "1");

    expect(tabs().ids).toEqual(["1"]);
  });

  test("worktrees keep their own conversations", () => {
    useAgentTabsStore.getState().open(WT);

    expect(tabs("/repo/wt/other").ids).toEqual(["1"]);
  });
});
