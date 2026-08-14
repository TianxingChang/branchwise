import { describe, expect, test } from "vitest";
import {
  agentKey,
  conversationOfKey,
  FIRST_CONVERSATION,
  isKeyUnder,
  worktreeOfKey,
} from "@/lib/agent/identity";

const WT = "/repo/wt/feature";

describe("agentKey", () => {
  test("the first conversation keeps the bare worktree path", () => {
    // Every transcript, registry entry and pending inheritance already on
    // disk is filed under this. Composing a key here would open every
    // existing branch to an empty conversation.
    expect(agentKey(WT, FIRST_CONVERSATION)).toBe(WT);
  });

  test("later conversations get a key of their own", () => {
    expect(agentKey(WT, "2")).not.toBe(WT);
    expect(agentKey(WT, "2")).not.toBe(agentKey(WT, "3"));
  });

  test("every key still names its worktree", () => {
    expect(worktreeOfKey(agentKey(WT, FIRST_CONVERSATION))).toBe(WT);
    expect(worktreeOfKey(agentKey(WT, "4"))).toBe(WT);
  });

  test("a worktree whose name could pass for a separator survives", () => {
    const awkward = "/repo/wt/feat#2::main";

    expect(worktreeOfKey(agentKey(awkward, "7"))).toBe(awkward);
  });

  test("the conversation id comes back out", () => {
    expect(conversationOfKey(agentKey(WT, "5"))).toBe("5");
  });

  test("a bare key reports no conversation, and is the first one", () => {
    // The bare path predates conversation ids; nothing wrote an id into it.
    expect(conversationOfKey(WT)).toBe("");
  });
});

describe("isKeyUnder", () => {
  test("matches every conversation of a worktree under a project", () => {
    expect(isKeyUnder(agentKey(WT, FIRST_CONVERSATION), "/repo")).toBe(true);
    expect(isKeyUnder(agentKey(WT, "3"), "/repo")).toBe(true);
  });

  test("does not match a project that merely shares a name prefix", () => {
    expect(isKeyUnder(agentKey("/repo-two/wt", "2"), "/repo")).toBe(false);
  });
});
