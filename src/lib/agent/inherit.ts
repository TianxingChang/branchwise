import type { AgentEvent } from "@/types/agent";

export interface InheritSource {
  childWorktree: string;
  parentLabel: string;
  parentWorktree: string;
}

/**
 * The context note both tiers lead with when paths may be stale.
 */
export function pathMappingNote(source: InheritSource): string {
  return `(Parent worktree: ${source.parentWorktree}, Child worktree: ${source.childWorktree})`;
}

/**
 * Deterministic digest of a parent transcript. Sections, in order:
 * 任务目标 (first user-message), 近期结论 (up to the last 3 assistant texts,
 * most recent last, each clipped to 500 chars), 触碰过的文件 (unique
 * tool-started details that look like paths under the parent worktree,
 * rewritten repo-relative, capped at 20), 未决事项 (trailing error events
 * and permission-requests still pending at the end). Skips empty sections.
 * Returns "" when the transcript has no user-message at all.
 */
export function buildBrief(events: AgentEvent[], source: InheritSource): string {
  // Check for presence of user-message events; return "" if none exist
  const hasUserMessage = events.some((e) => e.kind === "user-message");
  if (!hasUserMessage) {
    return "";
  }

  // Extract first user-message text
  let goal = "";
  for (const event of events) {
    if (event.kind === "user-message") {
      goal = event.text;
      break;
    }
  }

  // Extract assistant texts (accumulate from text-delta, reset on turn-done)
  const assistantTexts: string[] = [];
  let currentTurnText = "";
  for (const event of events) {
    if (event.kind === "text-delta") {
      currentTurnText += event.text;
    } else if (event.kind === "turn-done") {
      if (currentTurnText.trim()) {
        assistantTexts.push(currentTurnText);
      }
      currentTurnText = "";
    }
  }

  // Keep up to last 3 assistant texts, clip each to 500 chars
  const recentTexts = assistantTexts.slice(-3).map((text) =>
    text.length > 500 ? text.slice(0, 500) : text
  );

  // Extract unique tool-started details that look like paths under parentWorktree
  const filesSet = new Set<string>();
  for (const event of events) {
    if (
      event.kind === "tool-started" &&
      event.detail.startsWith(source.parentWorktree + "/")
    ) {
      // Rewrite to repo-relative
      const repoRelative = event.detail.slice(
        source.parentWorktree.length + 1
      );
      filesSet.add(repoRelative);
      if (filesSet.size >= 20) break;
    }
  }
  const files = Array.from(filesSet);

  // Build a Set of resolved permission requestIds
  const resolvedRequestIds = new Set<string>();
  for (const event of events) {
    if (event.kind === "permission-resolved") {
      resolvedRequestIds.add(event.requestId);
    }
  }

  // Find the index of the last turn-done event
  let lastTurnDoneIndex = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.kind === "turn-done") {
      lastTurnDoneIndex = i;
      break;
    }
  }

  // Extract trailing error events and unresolved permission-requests
  const openItems: string[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (
      event.kind === "error" &&
      i > lastTurnDoneIndex
    ) {
      // Only errors after the last turn-done
      openItems.push(event.message);
    } else if (event.kind === "permission-request") {
      // Include unresolved permissions anywhere in transcript
      if (!resolvedRequestIds.has(event.requestId)) {
        openItems.push(`Permission request: ${event.toolName}`);
      }
    }
  }

  // Build markdown
  const sections: string[] = [];
  sections.push(`# ${source.parentLabel}`);
  sections.push("");

  if (goal) {
    sections.push("## 任务目标");
    sections.push(goal);
    sections.push("");
  }

  if (recentTexts.length > 0) {
    sections.push("## 近期结论");
    sections.push(recentTexts.join("\n\n"));
    sections.push("");
  }

  if (files.length > 0) {
    sections.push("## 触碰过的文件");
    sections.push(files.map((f) => `- ${f}`).join("\n"));
    sections.push("");
  }

  if (openItems.length > 0) {
    sections.push("## 未决事项");
    sections.push(openItems.map((i) => `- ${i}`).join("\n"));
    sections.push("");
  }

  return sections.join("\n").trim();
}

/**
 * The parent's visible conversation as role/text pairs for codex
 * thread/inject_items: user-message events verbatim; assistant text
 * accumulated from text-delta events between turn-started and turn-done —
 * the turn-done EVENT carries no text; only the fold's item does — skipping
 * turns whose accumulated text is empty. Tool chatter, thinking and
 * permissions are deliberately not replayed.
 */
export function buildHistoryMessages(
  events: AgentEvent[]
): { role: "assistant" | "user"; text: string }[] {
  const messages: { role: "assistant" | "user"; text: string }[] = [];
  let currentTurnText = "";

  for (const event of events) {
    if (event.kind === "user-message") {
      messages.push({ role: "user", text: event.text });
    } else if (event.kind === "text-delta") {
      currentTurnText += event.text;
    } else if (event.kind === "turn-done") {
      if (currentTurnText.trim()) {
        messages.push({ role: "assistant", text: currentTurnText });
      }
      currentTurnText = "";
    }
  }

  return messages;
}
