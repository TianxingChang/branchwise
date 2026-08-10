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

function extractGoal(events: AgentEvent[]): string {
  for (const event of events) {
    if (event.kind === "user-message") {
      return event.text;
    }
  }
  return "";
}

function collectAssistantTexts(events: AgentEvent[]): string[] {
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
  return assistantTexts;
}

function collectTouchedFiles(
  events: AgentEvent[],
  parentWorktree: string
): string[] {
  const filesSet = new Set<string>();
  const prefix = `${parentWorktree}/`;
  for (const event of events) {
    if (event.kind === "tool-started" && event.detail.startsWith(prefix)) {
      const repoRelative = event.detail.slice(prefix.length);
      filesSet.add(repoRelative);
      if (filesSet.size >= 20) {
        break;
      }
    }
  }
  return Array.from(filesSet);
}

function findLastTurnDoneIndex(events: AgentEvent[]): number {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.kind === "turn-done") {
      return i;
    }
  }
  return -1;
}

function collectOpenItems(
  events: AgentEvent[],
  lastTurnDoneIndex: number
): string[] {
  const resolvedRequestIds = new Set<string>();
  const openItems: string[] = [];

  for (const event of events) {
    if (event.kind === "permission-resolved") {
      resolvedRequestIds.add(event.requestId);
    }
  }

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event?.kind === "error" && i > lastTurnDoneIndex) {
      openItems.push(event.message);
    } else if (
      event?.kind === "permission-request" &&
      !resolvedRequestIds.has(event.requestId)
    ) {
      openItems.push(`Permission request: ${event.toolName}`);
    }
  }

  return openItems;
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
export function buildBrief(
  events: AgentEvent[],
  source: InheritSource
): string {
  const hasUserMessage = events.some((e) => e.kind === "user-message");
  if (!hasUserMessage) {
    return "";
  }

  const goal = extractGoal(events);
  const assistantTexts = collectAssistantTexts(events);
  const recentTexts = assistantTexts
    .slice(-3)
    .map((text) => (text.length > 500 ? text.slice(0, 500) : text));
  const files = collectTouchedFiles(events, source.parentWorktree);
  const lastTurnDoneIndex = findLastTurnDoneIndex(events);
  const openItems = collectOpenItems(events, lastTurnDoneIndex);

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
