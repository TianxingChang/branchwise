import { useCallback } from "react";
import type { ConversationItem } from "@/lib/agent/fold";
import { cn } from "@/utils/tailwind";

type ToolItem = Extract<ConversationItem, { kind: "tool" }>;
type PermissionItem = Extract<ConversationItem, { kind: "permission" }>;
type NoticeItem = Extract<ConversationItem, { kind: "notice" }>;

/**
 * Same dot the canvas node badge uses (branch-node.tsx's StatBadge): a
 * size-1.5 rounded-full swatch, pulsing while the state is in flight. Tool
 * errors reuse bw-pending rather than a new red — that is the token this
 * codebase already renders every other error state in (file-tab, terminal-tab)
 * and red is reserved for the yolo danger warning.
 */
const TOOL_DOT_COLOR: Record<ToolItem["state"], string> = {
  error: "bg-bw-pending",
  ok: "bg-bw-done",
  running: "bg-bw-running",
};

export function ToolCard({ item }: { item: ToolItem }) {
  const finished = item.state !== "running";

  return (
    <div className="flex items-start gap-2 pl-5">
      <span
        aria-hidden
        className={cn(
          "mt-[5px] size-1.5 shrink-0 rounded-full",
          TOOL_DOT_COLOR[item.state],
          item.state === "running" && "animate-pulse motion-reduce:animate-none"
        )}
      />
      <p className="min-w-0 flex-1 whitespace-pre-wrap text-[12px] text-bw-muted leading-relaxed">
        <span className="text-bw-ink">{item.name}</span>
        {item.detail ? ` — ${item.detail}` : null}
        {finished && item.result ? (
          <span className="block">{item.result}</span>
        ) : null}
      </p>
    </div>
  );
}

export function PermissionCard({
  item,
  onRespond,
}: {
  item: PermissionItem;
  onRespond: (requestId: string, approved: boolean) => void;
}) {
  const approve = useCallback(() => {
    onRespond(item.requestId, true);
  }, [item.requestId, onRespond]);

  const deny = useCallback(() => {
    onRespond(item.requestId, false);
  }, [item.requestId, onRespond]);

  return (
    <div className="ml-5 flex flex-col gap-2 rounded-xl border border-bw-hairline bg-bw-subtle px-3 py-2.5">
      <p className="text-[12.5px] text-bw-ink leading-relaxed">
        <span className="font-medium">{item.toolName}</span> wants to run
      </p>
      <code className="whitespace-pre-wrap rounded-md bg-bw-surface px-2 py-1 font-mono text-[11.5px] text-bw-ink">
        {item.detail}
      </code>

      {item.state === "pending" ? (
        <div className="flex gap-2 pt-0.5">
          <button
            className="rounded-lg bg-bw-ink px-2.5 py-1 text-[11.5px] text-white transition-opacity hover:opacity-90"
            onClick={approve}
            type="button"
          >
            Approve
          </button>
          <button
            className="rounded-lg border border-bw-hairline px-2.5 py-1 text-[11.5px] text-bw-muted transition-colors hover:border-bw-edge hover:text-bw-ink"
            onClick={deny}
            type="button"
          >
            Deny
          </button>
        </div>
      ) : (
        <span className="text-[10.5px] text-bw-muted uppercase tracking-wide">
          {item.state}
        </span>
      )}
    </div>
  );
}

export function NoticeCard({ item }: { item: NoticeItem }) {
  return (
    <p className="ml-5 whitespace-pre-wrap rounded-xl border border-bw-pending/30 bg-bw-pending/10 px-3 py-2 text-[12.5px] text-bw-pending leading-relaxed">
      {item.text}
    </p>
  );
}
