import {
  Background,
  BackgroundVariant,
  type Edge,
  type Node,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { worktreeStatus } from "@/actions/repo";
import BranchNodeCard, {
  type BranchNodeData,
} from "@/components/canvas/branch-node";
import DeleteDialog, {
  type DeleteChoice,
} from "@/components/canvas/delete-dialog";
import { layoutTree, NODE_HEIGHT, NODE_WIDTH } from "@/lib/branch/layout";
import { useRepoStore } from "@/stores/repo-store";
import type { CanvasNode, ParentSource } from "@/types/branch";

const nodeTypes = { branch: BranchNodeCard };
const DRAFT_ID = "__branchwise_draft__";
const ERROR_TIMEOUT_MS = 4000;

/** Inferred edges are drawn lighter than ones the user or branchwise set. */
const EDGE_OPACITY: Record<ParentSource, number> = {
  created: 1,
  reflog: 0.7,
  root: 0.45,
  user: 1,
};

interface BranchCanvasProps {
  nodes: CanvasNode[];
  projectFolder: string;
  selectedId: string | null;
}

export default function BranchCanvas(props: BranchCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function draftNodeFor(parent: CanvasNode): CanvasNode {
  return {
    branch: null,
    detached: false,
    head: "",
    id: DRAFT_ID,
    isRoot: false,
    locked: false,
    parentId: parent.id,
    parentSource: "created",
    prunable: false,
  };
}

function CanvasInner({ nodes, projectFolder, selectedId }: BranchCanvasProps) {
  const selectNode = useRepoStore((state) => state.selectNode);
  const createBranch = useRepoStore((state) => state.createBranch);
  const deleteNode = useRepoStore((state) => state.deleteNode);

  const [draftParentId, setDraftParentId] = useState<string | null>(null);
  const [parentDirtyCount, setParentDirtyCount] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CanvasNode | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!error) {
      return;
    }
    const timer = setTimeout(() => setError(null), ERROR_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [error]);

  const byId = useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes]
  );

  // A dirty parent does not block branching, but the child will start from the
  // parent's last commit — worth saying before the name is even typed.
  useEffect(() => {
    if (draftParentId === null) {
      setParentDirtyCount(null);
      return;
    }

    let active = true;
    const parent = byId.get(draftParentId);
    if (!parent) {
      return;
    }

    worktreeStatus({
      branch: parent.branch,
      parentBranch: null,
      path: projectFolder,
      worktreePath: parent.id,
    })
      .then((status) => {
        if (active) {
          setParentDirtyCount(status.dirtyCount);
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [byId, draftParentId, projectFolder]);

  const cancelDraft = useCallback(() => setDraftParentId(null), []);

  const commitDraft = useCallback(
    async (name: string) => {
      const parent = draftParentId ? byId.get(draftParentId) : null;
      if (!parent) {
        return;
      }

      setDraftParentId(null);
      const startPoint = parent.branch ?? parent.head;
      const result = await createBranch(projectFolder, startPoint, name);
      if (!result.ok) {
        setError(result.error);
      }
    },
    [byId, createBranch, draftParentId, projectFolder]
  );

  const confirmDelete = useCallback(
    async (choice: DeleteChoice) => {
      const node = pendingDelete;
      if (!node) {
        return;
      }

      setPendingDelete(null);
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

  const displayNodes = useMemo(() => {
    const parent = draftParentId ? byId.get(draftParentId) : null;
    return parent ? [...nodes, draftNodeFor(parent)] : nodes;
  }, [byId, draftParentId, nodes]);

  const { fitView } = useReactFlow();
  const nodeCount = displayNodes.length;
  const lastNodeCount = useRef(nodeCount);

  // Re-frame whenever the tree gains or loses a node, whoever caused it — an
  // agent adding a worktree should not leave the new node off screen. The
  // selection is untouched, so the panel keeps showing what it was showing.
  useEffect(() => {
    if (lastNodeCount.current === nodeCount) {
      return;
    }
    lastNodeCount.current = nodeCount;
    fitView({ duration: 320, maxZoom: 1, padding: 0.3 });
  }, [fitView, nodeCount]);

  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    let previousWidth = element.clientWidth;
    const observer = new ResizeObserver(() => {
      const width = element.clientWidth;
      if (Math.abs(width - previousWidth) < 8) {
        return;
      }
      previousWidth = width;
      fitView({ duration: 200, maxZoom: 1, padding: 0.3 });
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [fitView]);

  const positions = useMemo(() => layoutTree(displayNodes), [displayNodes]);

  const flowNodes = useMemo<Node<BranchNodeData>[]>(
    () =>
      displayNodes.map((node) => ({
        data: {
          isDraft: node.id === DRAFT_ID,
          isSelected: node.id === selectedId,
          node,
          onCancelDraft: cancelDraft,
          onCommitDraft: commitDraft,
          onDelete: () => setPendingDelete(node),
          onStartChild: () => setDraftParentId(node.id),
          parentDirtyCount,
          projectFolder,
        },
        draggable: false,
        height: NODE_HEIGHT,
        id: node.id,
        position: positions.get(node.id) ?? { x: 0, y: 0 },
        selectable: node.id !== DRAFT_ID,
        type: "branch",
        width: NODE_WIDTH,
      })),
    [
      cancelDraft,
      commitDraft,
      displayNodes,
      parentDirtyCount,
      positions,
      projectFolder,
      selectedId,
    ]
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      displayNodes
        .filter((node) => node.parentId !== null)
        .map((node) => ({
          id: `${node.parentId}->${node.id}`,
          source: node.parentId as string,
          style: { opacity: EDGE_OPACITY[node.parentSource] },
          target: node.id,
          type: "smoothstep",
        })),
    [displayNodes]
  );

  const handleNodeClick = useCallback(
    (_event: unknown, node: { id: string }) => {
      if (node.id !== DRAFT_ID) {
        selectNode(projectFolder, node.id);
      }
    },
    [projectFolder, selectNode]
  );

  const handlePaneClick = useCallback(() => {
    setDraftParentId(null);
    selectNode(projectFolder, null);
  }, [projectFolder, selectNode]);

  const cancelDelete = useCallback(() => setPendingDelete(null), []);

  const childCount = pendingDelete
    ? nodes.filter((node) => node.parentId === pendingDelete.id).length
    : 0;
  const deleteParentBranch = pendingDelete?.parentId
    ? (byId.get(pendingDelete.parentId)?.branch ?? null)
    : null;

  return (
    <div
      className="branchwise-canvas relative h-full w-full"
      ref={containerRef}
    >
      <ReactFlow
        edges={flowEdges}
        elementsSelectable
        fitView
        fitViewOptions={{ maxZoom: 1, padding: 0.35 }}
        maxZoom={1.75}
        minZoom={0.25}
        nodes={flowNodes}
        nodesConnectable={false}
        nodesDraggable={false}
        nodeTypes={nodeTypes}
        onlyRenderVisibleElements={false}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
        panOnScroll
        selectionOnDrag={false}
        zoomOnDoubleClick={false}
      >
        <Background
          color="#e2e1dc"
          gap={26}
          size={1.4}
          variant={BackgroundVariant.Dots}
        />
      </ReactFlow>

      {error ? (
        <div
          className="absolute bottom-6 left-1/2 max-w-[80%] -translate-x-1/2 rounded-lg border border-bw-hairline bg-bw-surface px-3 py-2 text-[12px] text-bw-ink shadow-[0_4px_12px_rgba(0,0,0,0.08)]"
          role="status"
        >
          {error}
        </div>
      ) : null}

      {pendingDelete ? (
        <DeleteDialog
          childCount={childCount}
          node={pendingDelete}
          onCancel={cancelDelete}
          onConfirm={confirmDelete}
          parentBranch={deleteParentBranch}
          projectFolder={projectFolder}
        />
      ) : null}
    </div>
  );
}
