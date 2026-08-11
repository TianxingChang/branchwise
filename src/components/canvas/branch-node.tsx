import { Handle, type NodeProps, Position } from "@xyflow/react";
import { Check, GitBranch, Lock, Plus, Trash2, Unlink } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NODE_HEIGHT, NODE_WIDTH } from "@/lib/branch/layout";
import { detachedLabel } from "@/lib/git/naming";
import {
  agentActivity,
  selectSession,
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
  onCommitDraft: (name: string, inherit: InheritMode) => void;
  onCommitRename: (name: string) => void;
  onDelete: () => void;
  onStartChild: () => void;
  parentDirtyCount: number | null;
  /** Whether the draft's parent has a conversation worth inheriting — fetched
   * by branch-canvas via the actions layer, not read from the agent store
   * (the store only populates once AgentTab has mounted for that worktree
   * this run; see final-review A4). */
  parentHasConversation: boolean;
  projectFolder: string;
};

const CARD_SIZE = { height: NODE_HEIGHT, width: NODE_WIDTH };

/** The draft card's three-way choice for seeding the new worktree's agent. */
export type InheritMode = "none" | "brief" | "full";

export function branchLabel(node: CanvasNode): string {
  return node.branch ?? detachedLabel(node.head);
}

function BranchNodeCard({ data }: NodeProps & { data: BranchNodeData }) {
  const { isSelected, node } = data;

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
          parentHasConversation={
            data.isDraft ? data.parentHasConversation : false
          }
          parentWorktreePath={data.isDraft ? node.parentId : null}
        />
      </div>
    );
  }

  return <BranchCard data={data} isSelected={isSelected} node={node} />;
}

function BranchCard({
  data,
  isSelected,
  node,
}: {
  data: BranchNodeData;
  isSelected: boolean;
  node: CanvasNode;
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

  const session = useAgentStore((state) => selectSession(state, node.id));
  const activity = useMemo(() => agentActivity(session), [session]);

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

          {(activity.running || activity.needsPermission) && !node.prunable ? (
            <span className="flex items-center gap-2 text-[10px] text-bw-muted leading-none">
              {activity.needsPermission ? (
                <StatBadge color="bg-bw-pending" title="Needs approval" />
              ) : null}
              {activity.running ? (
                <StatBadge color="bg-bw-running" pulse title="Agent running" />
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

/** Stopping the mousedown's default prevents the input from blurring (and
 * thus committing) before the click handler on the pressed control runs. */
function preventBlur(event: React.MouseEvent) {
  event.preventDefault();
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
  parentHasConversation,
  parentWorktreePath,
}: {
  initialValue: string;
  onCancel: () => void;
  onCommit: (name: string, inherit: InheritMode) => void;
  parentDirtyCount: number | null;
  parentHasConversation: boolean;
  parentWorktreePath: string | null;
}) {
  const [value, setValue] = useState(initialValue);
  const [inheritMode, setInheritMode] = useState<InheritMode>("brief");
  const inputRef = useRef<HTMLInputElement>(null);

  // Offering to inherit only makes sense once the parent has something to
  // hand down — an empty conversation would seed the child with nothing.
  // parentHasConversation arrives as a prop (final-review A4): the agent
  // store only populates a worktree's session once AgentTab has mounted for
  // it this run, which made this control disappear after a relaunch.
  const showInherit = parentWorktreePath !== null && parentHasConversation;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = useCallback(() => {
    if (value.trim().length > 0) {
      onCommit(value, showInherit ? inheritMode : "none");
    } else {
      onCancel();
    }
  }, [inheritMode, onCancel, onCommit, showInherit, value]);

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

  const showHint =
    showInherit || (parentDirtyCount !== null && parentDirtyCount > 0);

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

      {showHint ? (
        <div className="absolute top-full left-0 mt-1.5 flex w-56 flex-col gap-1.5">
          {showInherit ? (
            <InheritControl onChange={setInheritMode} value={inheritMode} />
          ) : null}
          {parentDirtyCount !== null && parentDirtyCount > 0 ? (
            <p className="text-[10.5px] text-bw-pending leading-snug">
              The parent has {parentDirtyCount} uncommitted{" "}
              {parentDirtyCount === 1 ? "change" : "changes"}. The new branch
              starts from its last commit.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The compact 无/简报/完整历史 segmented control offered under the draft
 * card's name input, once the parent has a conversation worth inheriting. */
function InheritControl({
  onChange,
  value,
}: {
  onChange: (mode: InheritMode) => void;
  value: InheritMode;
}) {
  const selectNone = useCallback(() => onChange("none"), [onChange]);
  const selectBrief = useCallback(() => onChange("brief"), [onChange]);
  const selectFull = useCallback(() => onChange("full"), [onChange]);

  return (
    <fieldset
      aria-label="Inherit conversation"
      className="m-0 flex items-center gap-1 border-0 p-0"
    >
      <InheritOption
        label="无"
        onSelect={selectNone}
        selected={value === "none"}
      />
      <InheritOption
        label="简报"
        onSelect={selectBrief}
        selected={value === "brief"}
      />
      <InheritOption
        label="完整历史"
        onSelect={selectFull}
        selected={value === "full"}
      />
    </fieldset>
  );
}

function InheritOption({
  label,
  onSelect,
  selected,
}: {
  label: string;
  onSelect: () => void;
  selected: boolean;
}) {
  return (
    <button
      aria-pressed={selected}
      className={cn(
        "rounded-full border px-1.5 py-0.5 font-mono text-[10px] transition-colors",
        selected
          ? "border-bw-accent/45 text-bw-accent"
          : "border-bw-hairline text-bw-muted hover:text-bw-ink"
      )}
      onClick={onSelect}
      onMouseDown={preventBlur}
      type="button"
    >
      {label}
    </button>
  );
}

function StatBadge({
  color,
  pulse,
  title,
}: {
  color: string;
  pulse?: boolean;
  title: string;
}) {
  return (
    <span
      className={cn(
        "size-1.5 rounded-full",
        color,
        pulse && "animate-pulse motion-reduce:animate-none"
      )}
      title={title}
    />
  );
}

// No memo(): the React Compiler is enabled for this project and memoizes
// component output on its own.
export default BranchNodeCard;
