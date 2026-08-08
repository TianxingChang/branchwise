import { Handle, type NodeProps, Position } from "@xyflow/react";
import { GitBranch, Lock, Unlink } from "lucide-react";
import { useMemo } from "react";
import { NODE_HEIGHT, NODE_WIDTH } from "@/lib/branch/layout";
import { detachedLabel } from "@/lib/git/naming";
import {
  conversationKey,
  countTasks,
  useAgentStore,
} from "@/stores/agent-store";
import type { CanvasNode } from "@/types/branch";
import { cn } from "@/utils/tailwind";

// React Flow's Node<T> requires T to satisfy Record<string, unknown>, and an
// interface has no implicit index signature — this has to stay a type alias.
// biome-ignore lint/style/useConsistentTypeDefinitions: see above
export type BranchNodeData = {
  isSelected: boolean;
  node: CanvasNode;
  projectFolder: string;
};

const CARD_SIZE = { height: NODE_HEIGHT, width: NODE_WIDTH };

export function branchLabel(node: CanvasNode): string {
  return node.branch ?? detachedLabel(node.head);
}

function BranchNodeCard({ data }: NodeProps & { data: BranchNodeData }) {
  const { isSelected, node, projectFolder } = data;

  const items = useAgentStore(
    (state) =>
      state.conversations[conversationKey(projectFolder, node.id)]?.items
  );
  const counts = useMemo(() => countTasks(items), [items]);
  const total = counts.done + counts.pending + counts.running;

  return (
    <div className="relative" style={CARD_SIZE}>
      <Handle position={Position.Left} type="target" />
      <Handle position={Position.Right} type="source" />

      <div
        className={cn(
          "group/node relative flex h-full w-full items-center gap-2.5 overflow-visible rounded-xl border bg-bw-surface pr-2.5 pl-3 transition-all",
          isSelected
            ? "border-bw-accent/45 shadow-[0_0_0_3px_rgba(47,107,255,0.10),0_2px_6px_rgba(0,0,0,0.05)]"
            : "border-bw-hairline shadow-[0_1px_2px_rgba(0,0,0,0.035)] hover:border-bw-edge",
          node.prunable && "opacity-60"
        )}
      >
        <span
          aria-hidden
          className={cn(
            "h-7 w-[3px] shrink-0 rounded-full",
            node.prunable ? "bg-bw-pending" : "bg-bw-edge"
          )}
        />

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-center gap-1.5 truncate font-mono text-[12.5px] text-bw-ink leading-none tracking-tight">
            {node.isRoot ? (
              <GitBranch className="shrink-0 text-bw-muted" size={11} />
            ) : null}
            {node.detached ? (
              <Unlink className="shrink-0 text-bw-muted" size={10} />
            ) : null}
            {node.locked ? (
              <Lock className="shrink-0 text-bw-muted" size={10} />
            ) : null}
            <span className="truncate">{branchLabel(node)}</span>
          </span>

          {node.prunable ? (
            <span className="text-[10px] text-bw-pending leading-none">
              directory missing
            </span>
          ) : null}

          {total > 0 && !node.prunable ? (
            <span className="flex items-center gap-2 text-[10px] text-bw-muted leading-none">
              {counts.pending > 0 ? (
                <StatBadge color="bg-bw-pending" value={counts.pending} />
              ) : null}
              {counts.running > 0 ? (
                <StatBadge color="bg-bw-running" pulse value={counts.running} />
              ) : null}
              {counts.done > 0 ? (
                <StatBadge color="bg-bw-done" value={counts.done} />
              ) : null}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function StatBadge({
  color,
  pulse,
  value,
}: {
  color: string;
  pulse?: boolean;
  value: number;
}) {
  return (
    <span className="flex items-center gap-1">
      <span
        className={cn(
          "size-1.5 rounded-full",
          color,
          pulse && "animate-pulse motion-reduce:animate-none"
        )}
      />
      {value}
    </span>
  );
}

// No memo(): the React Compiler is enabled for this project and memoizes
// component output on its own.
export default BranchNodeCard;
