import { Handle, type NodeProps, Position } from "@xyflow/react";
import { Check, GitBranch, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NODE_HEIGHT, NODE_WIDTH } from "@/lib/branch/layout";
import {
  conversationKey,
  countTasks,
  useAgentStore,
} from "@/stores/agent-store";
import type { BranchStatus } from "@/types/branch";
import { cn } from "@/utils/tailwind";

export type BranchNodeMode = "view" | "rename" | "draft";

// React Flow's Node<T> requires T to satisfy Record<string, unknown>, and an
// interface has no implicit index signature — this has to stay a type alias.
// biome-ignore lint/style/useConsistentTypeDefinitions: see above
export type BranchNodeData = {
  isRoot: boolean;
  isSelected: boolean;
  mode: BranchNodeMode;
  name: string;
  nodeId: string;
  onCancelEdit: () => void;
  onCommitEdit: (name: string) => void;
  onDelete: () => void;
  onStartChild: () => void;
  projectPath: string;
  status: BranchStatus;
};

const STATUS_COLOR: Record<BranchStatus, string> = {
  done: "bg-bw-done",
  idle: "bg-bw-edge",
  running: "bg-bw-running",
};

const CARD_SIZE = { height: NODE_HEIGHT, width: NODE_WIDTH };

function BranchNodeCard({ data }: NodeProps & { data: BranchNodeData }) {
  const isEditing = data.mode !== "view";

  return (
    <div className="relative" style={CARD_SIZE}>
      <Handle position={Position.Left} type="target" />
      <Handle position={Position.Right} type="source" />

      {isEditing ? (
        <BranchNameEditor
          initialValue={data.mode === "rename" ? data.name : ""}
          onCancel={data.onCancelEdit}
          onCommit={data.onCommitEdit}
        />
      ) : (
        <BranchCardBody data={data} />
      )}
    </div>
  );
}

function BranchCardBody({ data }: { data: BranchNodeData }) {
  // Select the items array itself — it is referentially stable between
  // updates. Returning a freshly built counts object from the selector would
  // give useSyncExternalStore a new snapshot on every render and loop forever.
  const items = useAgentStore(
    (state) =>
      state.conversations[conversationKey(data.projectPath, data.nodeId)]?.items
  );
  const counts = useMemo(() => countTasks(items), [items]);

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

  const total = counts.done + counts.pending + counts.running;

  return (
    <div
      className={cn(
        "group/node relative flex h-full w-full items-center gap-2.5 overflow-visible rounded-xl border bg-bw-surface pr-2.5 pl-3 transition-all",
        data.isSelected
          ? "border-bw-accent/45 shadow-[0_0_0_3px_rgba(47,107,255,0.10),0_2px_6px_rgba(0,0,0,0.05)]"
          : "border-bw-hairline shadow-[0_1px_2px_rgba(0,0,0,0.035)] hover:border-bw-edge"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "h-7 w-[3px] shrink-0 rounded-full",
          STATUS_COLOR[data.status]
        )}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-1.5 truncate font-mono text-[12.5px] text-bw-ink leading-none tracking-tight">
          {data.isRoot ? (
            <GitBranch className="shrink-0 text-bw-muted" size={11} />
          ) : null}
          <span className="truncate">{data.name}</span>
        </span>
        {total > 0 ? (
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

      {data.isRoot ? null : (
        <button
          aria-label={`Delete branch ${data.name}`}
          className="absolute -top-2 -right-2 flex size-5 items-center justify-center rounded-full border border-bw-hairline bg-bw-surface text-bw-muted opacity-0 shadow-sm transition-opacity hover:text-bw-ink group-hover/node:opacity-100"
          onClick={handleDelete}
          type="button"
        >
          <Trash2 size={10} />
        </button>
      )}

      {/*
        The signature affordance: hovering pulls a dashed stub and a + out of
        the right edge, so branching reads as the connector physically growing.
      */}
      <div className="pointer-events-none absolute top-1/2 -right-11 flex -translate-y-1/2 items-center opacity-0 transition-opacity duration-150 group-hover/node:pointer-events-auto group-hover/node:opacity-100">
        <span
          aria-hidden
          className="h-px w-5 border-bw-edge border-t border-dashed"
        />
        <button
          aria-label={`Branch from ${data.name}`}
          className="flex size-6 items-center justify-center rounded-full border border-bw-hairline bg-bw-surface text-bw-muted shadow-[0_1px_3px_rgba(0,0,0,0.08)] transition-colors hover:border-bw-accent/40 hover:text-bw-accent"
          onClick={handleStartChild}
          title="Create child branch"
          type="button"
        >
          <Plus size={13} strokeWidth={2.25} />
        </button>
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

function BranchNameEditor({
  initialValue,
  onCancel,
  onCommit,
}: {
  initialValue: string;
  onCancel: () => void;
  onCommit: (name: string) => void;
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

  // Keep focus on mousedown so the button's click lands before the input blurs.
  const preventBlur = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
  }, []);

  return (
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
        aria-label="Confirm branch name"
        className="flex size-5 shrink-0 items-center justify-center rounded text-bw-muted hover:text-bw-accent"
        onClick={commit}
        onMouseDown={preventBlur}
        type="button"
      >
        <Check size={12} />
      </button>
    </div>
  );
}

// No memo(): the React Compiler is enabled for this project and memoizes
// component output on its own.
export default BranchNodeCard;
