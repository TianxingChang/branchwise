import { Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { worktreeDiffSummary } from "@/actions/repo";
import Composer from "@/components/panel/agent/composer";
import MessageBody from "@/components/panel/agent/message-body";
import ThinkingTrace from "@/components/panel/agent/thinking-trace";
import {
  NoticeCard,
  PermissionCard,
  ToolCard,
} from "@/components/panel/agent-cards";
import AgentConfigBar from "@/components/panel/agent-config-bar";
import type { ConversationItem } from "@/lib/agent/fold";
import {
  type AgentInheritance,
  selectSession,
  useAgentStore,
} from "@/stores/agent-store";
import { conversationsOf, useAgentTabsStore } from "@/stores/agent-tabs-store";
import { useRepoStore } from "@/stores/repo-store";
import type { AgentConfig, AgentUsage } from "@/types/agent";
import type { DiffSummary } from "@/types/diff";
import { cn } from "@/utils/tailwind";

/**
 * How wide the conversation is allowed to get, whatever the panel does.
 *
 * Wider than a measure for prose alone (user call, 2026-08-13). At this tab's
 * 14.5px the textbook 75-character line lands near 34rem, and this is closer
 * to 95 — deliberately, because a transcript is not a page of prose. It is
 * prose interleaved with code blocks, tool chips and file paths, all of which
 * want room, and against a panel dragged wide the alternative was worse: a
 * narrow column stranded between two empty margins.
 *
 * There is still no matching minimum. The column is fluid below the cap and
 * the floor is the panel's own MIN_PANEL_WIDTH; a min-width here would
 * overflow a narrow panel sideways rather than protect anything.
 */
const MEASURE = "mx-auto w-full max-w-[46rem]";

/** The transcript reads at its own scale; see --bw-prose-size in global.css. */
const PROSE_SCALE = "[--bw-prose-size:14.5px]";

interface AgentTabProps {
  branchLabel: string;
  head: string;
  parentBranch: string | null;
  projectFolder: string;
  worktreePath: string;
}

export default function AgentTab({
  branchLabel,
  head,
  parentBranch,
  projectFolder,
  worktreePath,
}: AgentTabProps) {
  const conversations = useAgentTabsStore((state) =>
    conversationsOf(state, worktreePath)
  );
  const openConversation = useAgentTabsStore((state) => state.open);
  const focusConversation = useAgentTabsStore((state) => state.focus);
  const closeConversation = useAgentTabsStore((state) => state.close);

  const target = useMemo(
    () => ({ conversationId: conversations.activeId, worktreePath }),
    [conversations.activeId, worktreePath]
  );

  const session = useAgentStore((state) => selectSession(state, target));
  const open = useAgentStore((state) => state.open);
  const close = useAgentStore((state) => state.close);
  const sendMessage = useAgentStore((state) => state.sendMessage);
  const interrupt = useAgentStore((state) => state.interrupt);
  const respond = useAgentStore((state) => state.respond);
  const configure = useAgentStore((state) => state.configure);

  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    open(target);
    return () => close(target);
  }, [close, open, target]);

  const { conversation } = session;
  const running = conversation.activeTurnId !== null;

  // items/streamingText are triggers, not references: the effect re-runs to
  // pin the view to the newest content. Removing them silently breaks
  // auto-scroll.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    const node = scrollRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [conversation.items, conversation.streamingText]);

  const submit = useCallback(() => {
    if (draft.trim().length === 0 || running) {
      return;
    }
    sendMessage(target, draft);
    setDraft("");
  }, [draft, running, sendMessage, target]);

  const handleNewConversation = useCallback(() => {
    openConversation(worktreePath);
    setDraft("");
  }, [openConversation, worktreePath]);

  const handleFocusConversation = useCallback(
    (conversationId: string) => {
      focusConversation(worktreePath, conversationId);
      setDraft("");
    },
    [focusConversation, worktreePath]
  );

  const handleCloseConversation = useCallback(
    (conversationId: string) => {
      closeConversation(worktreePath, conversationId);
    },
    [closeConversation, worktreePath]
  );

  const handleInterrupt = useCallback(() => {
    interrupt(target);
  }, [interrupt, target]);

  const handleRespond = useCallback(
    (requestId: string, approved: boolean) => {
      respond(target, requestId, approved);
    },
    [respond, target]
  );

  const handleConfigChange = useCallback(
    (config: AgentConfig) => {
      configure(target, config);
    },
    [configure, target]
  );

  const hasContent = conversation.items.length > 0 || running;
  // The cost line has to stick to the last assistant reply specifically, not
  // the last array slot: the next user message (or a trailing tool item)
  // becomes the new last item the moment the user replies, which would
  // otherwise make the estimate vanish right after it appears.
  const lastAssistantId =
    conversation.items.findLast((item) => item.kind === "assistant")?.id ??
    null;

  return (
    <div className="flex h-full flex-col">
      <DiffStrip
        head={head}
        nodeId={worktreePath}
        parentBranch={parentBranch}
        projectFolder={projectFolder}
      />

      <ConversationStrip
        activeId={conversations.activeId}
        ids={conversations.ids}
        onClose={handleCloseConversation}
        onOpen={handleNewConversation}
        onSelect={handleFocusConversation}
      />

      {session.inherited ? (
        <InheritedBadge inherited={session.inherited} />
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" ref={scrollRef}>
        <div className={cn(MEASURE, PROSE_SCALE, "space-y-3")}>
          {hasContent ? null : <EmptyConversation />}

          {conversation.items.map((item) => (
            <ConversationItemRow
              item={item}
              key={item.id}
              onRespond={handleRespond}
              showCost={item.id === lastAssistantId}
            />
          ))}

          {running ? (
            <StreamingMessage
              text={conversation.streamingText}
              thinking={conversation.streamingThinking}
            />
          ) : null}
        </div>
      </div>

      <div className={cn(MEASURE, "px-3 pt-1 pb-3")}>
        <Composer
          controls={
            session.config ? (
              <AgentConfigBar
                config={session.config}
                hasConversation={session.hasConversation}
                onChange={handleConfigChange}
              />
            ) : null
          }
          disabled={running}
          onChange={setDraft}
          onInterrupt={handleInterrupt}
          onSubmit={submit}
          placeholder={`Ask the agent to work on ${branchLabel}…`}
          running={running}
          text={draft}
        />
      </div>
    </div>
  );
}

/**
 * The worktree's conversations.
 *
 * Always shown, including the single conversation every branch starts with
 * (user call, 2026-08-13). Hiding it until there were two made the strip
 * appear out of nowhere on the second, and left nothing on screen saying that
 * a conversation is a thing a branch can have more than one of.
 */
function ConversationStrip({
  activeId,
  ids,
  onClose,
  onOpen,
  onSelect,
}: {
  activeId: string;
  ids: string[];
  onClose: (conversationId: string) => void;
  onOpen: () => void;
  onSelect: (conversationId: string) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-bw-hairline border-b px-3 py-1.5">
      {ids.map((id, at) => (
        <ConversationChip
          at={at}
          // The last one cannot be closed: it owns the history the branch
          // already had, and the tab always shows a conversation.
          canClose={ids.length > 1}
          id={id}
          isActive={id === activeId}
          key={id}
          onClose={onClose}
          onSelect={onSelect}
        />
      ))}
      <button
        aria-label="New conversation"
        className="flex size-5 shrink-0 items-center justify-center rounded-chip text-bw-muted transition-colors duration-150 hover:bg-bw-subtle hover:text-bw-ink"
        onClick={onOpen}
        title="New conversation"
        type="button"
      >
        <Plus size={13} />
      </button>
    </div>
  );
}

function ConversationChip({
  at,
  canClose,
  id,
  isActive,
  onClose,
  onSelect,
}: {
  at: number;
  canClose: boolean;
  id: string;
  isActive: boolean;
  onClose: (conversationId: string) => void;
  onSelect: (conversationId: string) => void;
}) {
  const handleSelect = useCallback(() => {
    onSelect(id);
  }, [id, onSelect]);

  const handleClose = useCallback(() => {
    onClose(id);
  }, [id, onClose]);

  return (
    <div
      className={cn(
        "group flex h-6 shrink-0 items-center gap-1 rounded-chip pr-0.5 pl-2 transition-colors duration-150",
        isActive
          ? "bg-bw-subtle text-bw-ink"
          : "text-bw-muted hover:bg-bw-subtle/60"
      )}
    >
      <button
        className="text-[11.5px] focus-visible:outline-none"
        onClick={handleSelect}
        type="button"
      >
        {/* Numbered by position, not by id: ids never repeat so they climb
            forever, and "Chat 7" beside "Chat 2" reads as a gap in a list
            rather than as the two conversations that are open. */}
        Chat {at + 1}
      </button>
      {canClose ? (
        <button
          aria-label={`Close chat ${at + 1}`}
          className="flex size-4 items-center justify-center rounded opacity-0 transition-opacity duration-150 hover:text-bw-ink focus-visible:opacity-100 group-hover:opacity-60"
          onClick={handleClose}
          type="button"
        >
          <X size={9} strokeWidth={2.5} />
        </button>
      ) : (
        // Keeps the chip the same width whether or not it can be closed, so
        // opening a second conversation does not shuffle the first sideways.
        <span aria-hidden="true" className="size-4 shrink-0" />
      )}
    </div>
  );
}

/**
 * "Is this going somewhere sane" in one line — the 80% question while an
 * agent runs. Clicking hands off to the Diff tab for the other 20%.
 */
function DiffStrip({
  head,
  nodeId,
  parentBranch,
  projectFolder,
}: {
  head: string;
  nodeId: string;
  parentBranch: string | null;
  projectFolder: string;
}) {
  const setPanelTab = useRepoStore((state) => state.setPanelTab);
  const [summary, setSummary] = useState<DiffSummary | null>(null);

  // head is a trigger: every new commit changes what the branch would land.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    let active = true;

    worktreeDiffSummary({
      parentBranch,
      path: projectFolder,
      worktreePath: nodeId,
    })
      .then((result) => {
        if (active) {
          setSummary(result);
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [head, nodeId, parentBranch, projectFolder]);

  const open = useCallback(() => {
    setPanelTab(projectFolder, "diff");
  }, [projectFolder, setPanelTab]);

  if (!summary || summary.files === 0) {
    return null;
  }

  return (
    <button
      className="flex items-center gap-2.5 border-bw-hairline border-b px-4 py-1.5 text-left font-mono text-[11px] transition-colors hover:bg-bw-subtle"
      onClick={open}
      type="button"
    >
      <span className="text-bw-muted">
        {summary.files} file{summary.files === 1 ? "" : "s"}
      </span>
      {summary.additions > 0 ? (
        <span className="text-bw-done">+{summary.additions}</span>
      ) : null}
      {summary.deletions > 0 ? (
        <span className="text-bw-removed">−{summary.deletions}</span>
      ) : null}
    </button>
  );
}

const INHERIT_MODE_LABELS: Record<AgentInheritance["mode"], string> = {
  brief: "简报",
  full: "完整",
};

/** Last non-empty path segment — "/wt/feat-parent" reads as "feat-parent". */
function pathTail(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? path;
}

/** Quiet, permanent context line: this worktree's first turn didn't start
 * from nothing — it inherited a conversation from another branch. Prefers
 * the persisted branch label; a root parent's worktree path is the repo
 * folder, not "main", so the path-tail fallback is only for records
 * written before `parentLabel` existed. */
function InheritedBadge({ inherited }: { inherited: AgentInheritance }) {
  const label = inherited.parentLabel ?? pathTail(inherited.from);
  return (
    <p className="px-4 pt-2 text-[10.5px] text-bw-muted">
      inherited from {label} ({INHERIT_MODE_LABELS[inherited.mode]})
    </p>
  );
}

function EmptyConversation() {
  return (
    <div className="flex flex-col gap-1.5 pt-6">
      <p className="text-[13px] text-bw-ink">No work on this branch yet.</p>
      <p className="text-[12.5px] text-bw-muted leading-relaxed">
        Describe what should happen here. Nothing runs until you send the first
        message.
      </p>
    </div>
  );
}

function AssistantText({ text }: { text: string }) {
  return (
    <div className="min-w-0">
      <MessageBody text={text} />
    </div>
  );
}

function ThinkingDetails({
  running,
  text,
}: {
  running?: boolean;
  text: string;
}) {
  return (
    <div>
      <ThinkingTrace running={running} text={text} />
    </div>
  );
}

/** Live turn: an empty streamingText keeps the "Thinking…" affordance up until
 * the first delta arrives, then the same block switches to real text. */
function StreamingMessage({
  text,
  thinking,
}: {
  text: string;
  thinking: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      {text ? (
        <AssistantText text={text} />
      ) : (
        <p className="text-[12.5px] text-bw-muted">Thinking…</p>
      )}
      {thinking ? <ThinkingDetails running text={thinking} /> : null}
    </div>
  );
}

/** "≈" doubles as the estimate label the brief asks for. */
function formatCost(costUsd: number, usage: AgentUsage | null): string {
  const amount = `≈ $${costUsd.toFixed(2)}`;
  if (!usage || (usage.inputTokens === null && usage.outputTokens === null)) {
    return amount;
  }
  const inTokens =
    usage.inputTokens === null ? "?" : formatTokenCount(usage.inputTokens);
  const outTokens =
    usage.outputTokens === null ? "?" : formatTokenCount(usage.outputTokens);
  return `${amount} · ${inTokens} in / ${outTokens} out`;
}

function formatTokenCount(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : `${count}`;
}

function ConversationItemRow({
  item,
  onRespond,
  showCost,
}: {
  item: ConversationItem;
  onRespond: (requestId: string, approved: boolean) => void;
  showCost: boolean;
}) {
  if (item.kind === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-card bg-bw-subtle px-3.5 py-2 text-[14.5px] text-bw-ink leading-relaxed">
          {item.text}
        </p>
      </div>
    );
  }

  if (item.kind === "assistant") {
    return (
      <div className="flex flex-col gap-1">
        <AssistantText text={item.text} />
        {item.thinking ? <ThinkingDetails text={item.thinking} /> : null}
        {showCost && item.costUsd !== null ? (
          <p className="text-[10.5px] text-bw-muted">
            {formatCost(item.costUsd, item.usage)}
          </p>
        ) : null}
      </div>
    );
  }

  if (item.kind === "tool") {
    return <ToolCard item={item} />;
  }

  if (item.kind === "permission") {
    return <PermissionCard item={item} onRespond={onRespond} />;
  }

  return <NoticeCard item={item} />;
}
