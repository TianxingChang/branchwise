import { GitBranch, Plus, Trash2, Unlink } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import BranchNameForm from "@/components/canvas/branch-name-form";
import { branchLabel } from "@/components/canvas/branch-node";
import DeleteDialog, {
  type DeleteChoice,
} from "@/components/canvas/delete-dialog";
import type { InheritMode } from "@/components/canvas/inherit-control";
import { treeRows } from "@/lib/branch/tree";
import { descendantNodeIds } from "@/lib/git/resolve";
import { useAgentStore, worktreeActivity } from "@/stores/agent-store";
import { useRepoStore } from "@/stores/repo-store";
import type { CanvasNode } from "@/types/branch";
import { cn } from "@/utils/tailwind";

/** Room each level of nesting adds, in px. */
const INDENT = 14;

interface BranchTreeProps {
  nodes: CanvasNode[];
  projectFolder: string;
  selectedId: string | null;
}

/**
 * The repository as an indented list.
 *
 * The same hierarchy the canvas draws, rendered where a graph cannot go. The
 * region left of the panel is as narrow as 208px in full posture, which is
 * unreadable as a graph and perfectly readable as a tree — so this is not
 * merely an alternative view, it is the one that works when the panel has
 * taken the room.
 *
 * It carries the canvas's operations rather than being a read-only outline: a
 * branch you can see but not branch from would send you back to the canvas for
 * every change, which defeats the point of staying here.
 */
export default function BranchTree({
  nodes,
  projectFolder,
  selectedId,
}: BranchTreeProps) {
  const selectNode = useRepoStore((state) => state.selectNode);
  const createBranch = useRepoStore((state) => state.createBranch);
  const deleteNode = useRepoStore((state) => state.deleteNode);
  const renameBranch = useRepoStore((state) => state.renameBranch);

  const [draftParentId, setDraftParentId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CanvasNode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => treeRows(nodes), [nodes]);
  const byId = useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes]
  );

  const commitDraft = useCallback(
    async (name: string, inheritMode: InheritMode) => {
      const parent = draftParentId ? byId.get(draftParentId) : null;
      setDraftParentId(null);
      if (!parent) {
        return;
      }

      const result = await createBranch(
        projectFolder,
        parent.branch ?? parent.head,
        name,
        inheritMode === "none"
          ? null
          : {
              mode: inheritMode,
              parentLabel: branchLabel(parent),
              parentWorktree: parent.id,
            }
      );
      if (!result.ok) {
        setError(result.error);
      }
    },
    [byId, createBranch, draftParentId, projectFolder]
  );

  const commitRename = useCallback(
    async (name: string) => {
      const node = renamingId ? byId.get(renamingId) : null;
      setRenamingId(null);
      if (!node?.branch || name === node.branch) {
        return;
      }
      const result = await renameBranch(projectFolder, node.branch, name);
      if (!result.ok) {
        setError(result.error);
      }
    },
    [byId, projectFolder, renameBranch, renamingId]
  );

  const confirmDelete = useCallback(
    async (choice: DeleteChoice) => {
      const node = pendingDelete;
      setPendingDelete(null);
      if (!node) {
        return;
      }
      const result = await deleteNode(projectFolder, {
        branch: node.branch,
        deleteBranch: choice.deleteBranch,
        force: choice.force,
        worktreePath: node.id,
      });
      if (!result.ok) {
        setError(result.error);
      }
    },
    [deleteNode, pendingDelete, projectFolder]
  );

  const cancelDelete = useCallback(() => setPendingDelete(null), []);
  const cancelDraft = useCallback(() => setDraftParentId(null), []);
  const cancelRename = useCallback(() => setRenamingId(null), []);

  const childCount = pendingDelete
    ? descendantNodeIds(nodes, pendingDelete.id).size
    : 0;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto py-2">
      {rows.map(({ depth, node }) => (
        <TreeRow
          depth={depth}
          isRenaming={renamingId === node.id}
          isSelected={node.id === selectedId}
          key={node.id}
          node={node}
          onCancelRename={cancelRename}
          onCommitRename={commitRename}
          onDelete={setPendingDelete}
          onRename={setRenamingId}
          onSelect={selectNode}
          onStartChild={setDraftParentId}
          projectFolder={projectFolder}
          showDraftBelow={draftParentId === node.id}
        >
          {draftParentId === node.id ? (
            <div style={{ paddingLeft: (depth + 1) * INDENT + 8 }}>
              <BranchNameForm
                onCancel={cancelDraft}
                onCommit={commitDraft}
                parentWorktreePath={node.id}
                placeholder="new branch"
              />
            </div>
          ) : null}
        </TreeRow>
      ))}

      {error ? (
        <p
          className="mx-2 mt-2 rounded-lg border border-bw-hairline bg-bw-surface px-2.5 py-2 text-[11.5px] text-bw-ink"
          role="status"
        >
          {error}
        </p>
      ) : null}

      {pendingDelete ? (
        <DeleteDialog
          childCount={childCount}
          node={pendingDelete}
          onCancel={cancelDelete}
          onConfirm={confirmDelete}
          parentBranch={byId.get(pendingDelete.parentId ?? "")?.branch ?? null}
          projectFolder={projectFolder}
        />
      ) : null}
    </div>
  );
}

function TreeRow({
  children,
  depth,
  isRenaming,
  isSelected,
  node,
  onCancelRename,
  onCommitRename,
  onDelete,
  onRename,
  onSelect,
  onStartChild,
  projectFolder,
}: {
  children: React.ReactNode;
  depth: number;
  isRenaming: boolean;
  isSelected: boolean;
  node: CanvasNode;
  onCancelRename: () => void;
  onCommitRename: (name: string) => void;
  onDelete: (node: CanvasNode) => void;
  onRename: (id: string) => void;
  onSelect: (projectFolder: string, id: string) => void;
  onStartChild: (id: string) => void;
  projectFolder: string;
  showDraftBelow: boolean;
}) {
  // Selecting `sessions` and folding outside the selector, not folding inside
  // it. worktreeActivity builds a fresh object every call, and the store hook
  // is backed by useSyncExternalStore, whose snapshot has to be stable — a new
  // object per render reads as a new value per render, which is an infinite
  // re-render rather than a stale badge.
  const sessions = useAgentStore((state) => state.sessions);
  const activity = useMemo(
    () => worktreeActivity(sessions, node.id),
    [node.id, sessions]
  );

  const handleSelect = useCallback(() => {
    onSelect(projectFolder, node.id);
  }, [node.id, onSelect, projectFolder]);

  const handleRename = useCallback(() => {
    if (node.branch && !node.isRoot) {
      onRename(node.id);
    }
  }, [node.branch, node.id, node.isRoot, onRename]);

  const handleStartChild = useCallback(() => {
    onStartChild(node.id);
  }, [node.id, onStartChild]);

  const handleDelete = useCallback(() => {
    onDelete(node);
  }, [node, onDelete]);

  if (isRenaming) {
    return (
      <div style={{ paddingLeft: depth * INDENT + 8 }}>
        <BranchNameForm
          initialValue={node.branch ?? ""}
          onCancel={onCancelRename}
          onCommit={onCommitRename}
          parentWorktreePath={null}
          placeholder="branch name"
        />
      </div>
    );
  }

  return (
    <>
      <div
        className={cn(
          "group flex h-7 shrink-0 items-center gap-1 pr-1 transition-colors duration-150",
          isSelected ? "bg-bw-subtle" : "hover:bg-bw-subtle/60"
        )}
        style={{ paddingLeft: depth * INDENT + 8 }}
      >
        {node.detached ? (
          <Unlink className="shrink-0 text-bw-edge" size={11} />
        ) : (
          <GitBranch className="shrink-0 text-bw-edge" size={11} />
        )}

        {/* Double-click sits on the name rather than the row: a row is not
            interactive, and hanging a handler on it would leave the gesture
            with no keyboard equivalent. */}
        <button
          className="min-w-0 flex-1 truncate text-left font-mono text-[11.5px] text-bw-ink focus-visible:outline-none"
          onClick={handleSelect}
          onDoubleClick={handleRename}
          title={node.id}
          type="button"
        >
          {branchLabel(node)}
        </button>

        {activity.needsPermission ? (
          <span
            aria-label="Waiting on you"
            className="size-1.5 shrink-0 rounded-full bg-bw-pending"
            title="Waiting on you"
          />
        ) : null}
        {activity.running ? (
          <span
            aria-label="Agent running"
            className="size-1.5 shrink-0 animate-pulse rounded-full bg-bw-running"
            title="Agent running"
          />
        ) : null}

        <button
          aria-label={`Branch from ${branchLabel(node)}`}
          className="flex size-5 shrink-0 items-center justify-center rounded text-bw-muted opacity-0 transition-opacity duration-150 hover:text-bw-ink focus-visible:opacity-100 group-hover:opacity-100"
          onClick={handleStartChild}
          title="Branch from here"
          type="button"
        >
          <Plus size={12} />
        </button>

        {node.isRoot ? null : (
          <button
            aria-label={`Delete ${branchLabel(node)}`}
            className="flex size-5 shrink-0 items-center justify-center rounded text-bw-muted opacity-0 transition-opacity duration-150 hover:text-bw-removed focus-visible:opacity-100 group-hover:opacity-100"
            onClick={handleDelete}
            title="Delete worktree"
            type="button"
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>

      {children}
    </>
  );
}
