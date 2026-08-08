import { describe, expect, test } from "vitest";
import type { ConversationItem } from "@/stores/agent-store";
import { conversationKey, countTasks } from "@/stores/agent-store";

function task(
  id: string,
  status: "queued" | "running" | "done"
): ConversationItem {
  return {
    agent: "Test Agent",
    description: "doing a thing",
    id,
    kind: "task",
    status,
  };
}

describe("countTasks", () => {
  test("returns zeros for an empty or absent conversation", () => {
    expect(countTasks(undefined)).toEqual({ done: 0, pending: 0, running: 0 });
    expect(countTasks([])).toEqual({ done: 0, pending: 0, running: 0 });
  });

  test("tallies tasks by status", () => {
    const items: ConversationItem[] = [
      task("1", "queued"),
      task("2", "running"),
      task("3", "done"),
      task("4", "done"),
    ];

    expect(countTasks(items)).toEqual({ done: 2, pending: 1, running: 1 });
  });

  test("ignores messages", () => {
    const items: ConversationItem[] = [
      { id: "m1", kind: "message", role: "user", text: "hi" },
      { id: "m2", kind: "message", role: "assistant", text: "hello" },
      task("1", "running"),
    ];

    expect(countTasks(items)).toEqual({ done: 0, pending: 0, running: 1 });
  });
});

describe("conversationKey", () => {
  test("scopes a conversation to one node inside one project", () => {
    expect(conversationKey("/repo", "main")).not.toBe(
      conversationKey("/other", "main")
    );
    expect(conversationKey("/repo", "main")).not.toBe(
      conversationKey("/repo", "feature")
    );
  });
});
