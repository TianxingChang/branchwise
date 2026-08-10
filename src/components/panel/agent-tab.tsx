import { ArrowUp, Sparkles, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { worktreeDiffSummary } from "@/actions/repo";
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
import { useRepoStore } from "@/stores/repo-store";
import type { AgentConfig, AgentUsage } from "@/types/agent";
import type { DiffSummary } from "@/types/diff";

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
  const session = useAgentStore((state) => selectSession(state, worktreePath));
  const open = useAgentStore((state) => state.open);
  const close = useAgentStore((state) => state.close);
  const sendMessage = useAgentStore((state) => state.sendMessage);
  const interrupt = useAgentStore((state) => state.interrupt);
  const respond = useAgentStore((state) => state.respond);
  const configure = useAgentStore((state) => state.configure);

  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    open(worktreePath);
    return () => close(worktreePath);
  }, [close, open, worktreePath]);

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
    sendMessage(worktreePath, draft);
    setDraft("");
  }, [draft, running, sendMessage, worktreePath]);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      setDraft(event.target.value);
    },
    []
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    },
    [submit]
  );

  const handleInterrupt = useCallback(() => {
    interrupt(worktreePath);
  }, [interrupt, worktreePath]);

  const handleRespond = useCallback(
    (requestId: string, approved: boolean) => {
      respond(worktreePath, requestId, approved);
    },
    [respond, worktreePath]
  );

  const handleConfigChange = useCallback(
    (config: AgentConfig) => {
      configure(worktreePath, config);
    },
    [configure, worktreePath]
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

      {session.inherited ? (
        <InheritedBadge inherited={session.inherited} />
      ) : null}

      <div
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
        ref={scrollRef}
      >
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

      {session.config ? (
        <AgentConfigBar
          config={session.config}
          hasConversation={session.hasConversation}
          onChange={handleConfigChange}
        />
      ) : null}

      <div className="border-bw-hairline border-t p-3">
        <div className="flex items-end gap-2 rounded-xl border border-bw-hairline bg-bw-canvas/60 py-2 pr-2 pl-3 focus-within:border-bw-edge">
          <textarea
            className="max-h-28 min-h-6 flex-1 resize-none bg-transparent text-[12.5px] text-bw-ink leading-relaxed outline-none placeholder:text-bw-muted"
            disabled={running}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={`Ask the agent to work on ${branchLabel}…`}
            rows={1}
            value={draft}
          />
          {running ? (
            <button
              className="flex shrink-0 items-center gap-1 rounded-full border border-bw-hairline px-2.5 py-1 text-[11px] text-bw-muted transition-colors hover:border-bw-edge hover:text-bw-ink"
              onClick={handleInterrupt}
              type="button"
            >
              <Square size={10} strokeWidth={2.5} />
              Interrupt
            </button>
          ) : null}
          <button
            aria-label="Send message"
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-bw-ink text-white transition-opacity disabled:opacity-25"
            disabled={draft.trim().length === 0 || running}
            onClick={submit}
            type="button"
          >
            <ArrowUp size={14} strokeWidth={2.5} />
          </button>
        </div>
      </div>
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
    <div className="flex gap-2">
      <Sparkles className="mt-0.5 shrink-0 text-bw-muted" size={13} />
      <p className="whitespace-pre-wrap text-[12.5px] text-bw-ink leading-relaxed">
        {text}
      </p>
    </div>
  );
}

function ThinkingDetails({ text }: { text: string }) {
  return (
    <details className="pl-6 text-[11px] text-bw-muted">
      <summary className="cursor-pointer select-none">thinking</summary>
      <p className="mt-1 whitespace-pre-wrap leading-relaxed">{text}</p>
    </details>
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
        <p className="pl-6 text-[12.5px] text-bw-muted">Thinking…</p>
      )}
      {thinking ? <ThinkingDetails text={thinking} /> : null}
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
        <p className="max-w-[85%] whitespace-pre-wrap rounded-xl bg-bw-subtle px-3 py-2 text-[12.5px] text-bw-ink leading-relaxed">
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
          <p className="pl-6 text-[10.5px] text-bw-muted">
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
