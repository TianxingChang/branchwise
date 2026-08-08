import { Handle, type NodeProps, Position } from "@xyflow/react";
import { Check, GitBranch, Lock, Plus, Trash2, Unlink } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  /** A draft node is the branch being named; it has no worktree yet. */
  isDraft: boolean;
  isRenaming: boolean;
  isSelected: boolean;
  node: CanvasNode;
  onCancelDraft: () => void;
  onCommitDraft: (name: string) => void;
  onCommitRename: (name: string) => void;
  onDelete: () => void;
  onStartChild: () => void;
  parentDirtyCount: number | null;
  projectFolder: string;
};

const CARD_SIZE = { height: NODE_HEIGHT, width: NODE_WIDTH };

export function branchLabel(node: CanvasNode): string {
  return node.branch ?? detachedLabel(node.head);
}

function BranchNodeCard({ data }: NodeProps & { data: BranchNodeData }) {
  const { isSelected, node, projectFolder } = data;

  if (data.isDraft || data.isRenaming) {
    return (
      <div className="relative" style={CARD_SIZE}>
        <Handle position={Position.Left} type="target" />
        <Handle position={Position.Right} type="source" />
        <BranchNameEditor
          initialValue={data.isRenaming ? (node.branch ?? "") : ""}
          onCancel={data.onCancelDraft}
          onCommit={data.isRenaming ? data.onCommitRename : data.onCommitDraft}
          parentDirtyCount={data.isDraft ? data.parentDirtyCount : null}
        />
      </div>
    );
  }

  return (
    <BranchCard
      data={data}
      isSelected={isSelected}
      node={node}
      projectFolder={projectFolder}
    />
  );
}

function BranchCard({
  data,
  isSelected,
  node,
  projectFolder,
}: {
  data: BranchNodeData;
  isSelected: boolean;
  node: CanvasNode;
  projectFolder: string;
}) {
  const { onDelete, onStartChild } = data;

  const handleDelete = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      onDelete();
    },
    [onDelete]
  );

  const handleStartChild = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      onStartChild();
    },
    [onStartChild]
  );

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

        {node.isRoot ? null : (
          <button
            aria-label={`Remove ${branchLabel(node)}`}
            className="absolute -top-2 -right-2 flex size-5 items-center justify-center rounded-full border border-bw-hairline bg-bw-surface text-bw-muted opacity-0 shadow-sm transition-opacity hover:text-bw-ink group-hover/node:opacity-100"
            onClick={handleDelete}
            type="button"
          >
            <Trash2 size={10} />
          </button>
        )}

        {/*
          The signature affordance: hovering pulls a dashed stub and a + out of
          the right edge, so branching reads as the connector physically
          growing.

          The stub is deliberately hit-testable: it bridges the gap between the
          card and the button, so travelling to the + never leaves the hovered
          element. Without that bridge the pointer crosses bare canvas, the
          group loses :hover, and the button — whose own pointer-events are
          gated on that same hover — can never win it back. Its left inset
          clears the source handle sitting on the card's edge, which has to
          stay grabbable for edge dragging.
        */}
        <div className="pointer-events-none absolute top-1/2 -right-12 flex -translate-y-1/2 items-center pl-1 opacity-0 transition-opacity duration-150 group-hover/node:opacity-100">
          <span
            aria-hidden
            className="pointer-events-auto flex h-6 w-5 items-center"
          >
            <span className="h-px w-full border-bw-edge border-t border-dashed" />
          </span>
          <button
            aria-label={`Branch from ${branchLabel(node)}`}
            className="pointer-events-none flex size-6 items-center justify-center rounded-full border border-bw-hairline bg-bw-surface text-bw-muted shadow-[0_1px_3px_rgba(0,0,0,0.08)] transition-colors hover:border-bw-accent/40 hover:text-bw-accent group-hover/node:pointer-events-auto"
            onClick={handleStartChild}
            title="Create a branch and worktree from here"
            type="button"
          >
            <Plus size={13} strokeWidth={2.25} />
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The inline editor a draft node renders. Enter commits, Escape cancels, and a
 * dirty parent gets a warning rather than a block — the child starts from the
 * parent's last commit either way.
 */
function BranchNameEditor({
  initialValue,
  onCancel,
  onCommit,
  parentDirtyCount,
}: {
  initialValue: string;
  onCancel: () => void;
  onCommit: (name: string) => void;
  parentDirtyCount: number | null;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = useCallback(() => {
    if (value.trim().length > 0) {
      onCommit(value);
    } else {
      onCancel();
    }
  }, [onCancel, onCommit, value]);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setValue(event.target.value);
    },
    []
  );

  // React Flow listens for keys on the pane, so stop them here: typing a branch
  // name must never trigger a canvas shortcut.
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        commit();
      }
      if (event.key === "Escape") {
        onCancel();
      }
    },
    [commit, onCancel]
  );

  const preventBlur = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
  }, []);

  return (
    <div className="relative h-full w-full">
      <div className="flex h-full w-full items-center gap-2 rounded-xl border border-bw-accent/45 bg-bw-surface pr-2 pl-3 shadow-[0_0_0_3px_rgba(47,107,255,0.10)]">
        <span
          aria-hidden
          className="h-7 w-[3px] shrink-0 rounded-full bg-bw-accent"
        />
        <input
          className="nodrag min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-bw-ink outline-none placeholder:text-bw-muted"
          onBlur={commit}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="branch name"
          ref={inputRef}
          value={value}
        />
        <button
          aria-label="Create branch"
          className="flex size-5 shrink-0 items-center justify-center rounded text-bw-muted hover:text-bw-accent"
          onClick={commit}
          onMouseDown={preventBlur}
          type="button"
        >
          <Check size={12} />
        </button>
      </div>

      {parentDirtyCount !== null && parentDirtyCount > 0 ? (
        <p className="absolute top-full left-0 mt-1.5 w-56 text-[10.5px] text-bw-pending leading-snug">
          The parent has {parentDirtyCount} uncommitted{" "}
          {parentDirtyCount === 1 ? "change" : "changes"}. The new branch starts
          from its last commit.
        </p>
      ) : null}
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
