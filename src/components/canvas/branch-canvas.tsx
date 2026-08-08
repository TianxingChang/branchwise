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
import BranchNodeCard, {
  type BranchNodeData,
} from "@/components/canvas/branch-node";
import { layoutTree, NODE_HEIGHT, NODE_WIDTH } from "@/lib/branch/layout";
import { useGraphStore } from "@/stores/graph-store";
import type { BranchNode, GraphDoc } from "@/types/branch";

const DRAFT_ID = "__branchwise_draft__";
const nodeTypes = { branch: BranchNodeCard };

type EditState =
  | { kind: "draft"; parentId: string }
  | { kind: "rename"; nodeId: string }
  | null;

interface BranchCanvasProps {
  doc: GraphDoc;
  projectPath: string;
}

export default function BranchCanvas(props: BranchCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function CanvasInner({ doc, projectPath }: BranchCanvasProps) {
  const addBranch = useGraphStore((state) => state.addBranch);
  const removeBranch = useGraphStore((state) => state.removeBranch);
  const renameBranch = useGraphStore((state) => state.renameBranch);
  const selectNode = useGraphStore((state) => state.selectNode);

  const [edit, setEdit] = useState<EditState>(null);
  const [error, setError] = useState<string | null>(null);

  const { fitView } = useReactFlow();
  const nodeCount = doc.nodes.length;
  const lastNodeCount = useRef(nodeCount);

  // Re-frame only when the tree's shape changes. Panning and zooming are the
  // user's business; adding or deleting a branch is ours.
  useEffect(() => {
    if (lastNodeCount.current === nodeCount) {
      return;
    }
    lastNodeCount.current = nodeCount;
    fitView({ duration: 320, maxZoom: 1, padding: 0.3 });
  }, [fitView, nodeCount]);

  // The canvas shrinks when the panel opens or is dragged wider. Re-frame so
  // branches never end up parked outside the visible area.
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

  useEffect(() => {
    if (!error) {
      return;
    }
    const timer = setTimeout(() => setError(null), 2600);
    return () => clearTimeout(timer);
  }, [error]);

  const cancelEdit = useCallback(() => setEdit(null), []);

  const commitEdit = useCallback(
    (name: string) => {
      if (!edit) {
        return;
      }

      const result =
        edit.kind === "draft"
          ? addBranch(projectPath, edit.parentId, name)
          : renameBranch(projectPath, edit.nodeId, name);

      if (result.ok) {
        setEdit(null);
      } else {
        setError(result.error);
      }
    },
    [addBranch, edit, projectPath, renameBranch]
  );

  /**
   * The in-progress branch is laid out as if it already existed, so the tree
   * settles into its final shape before the name is even typed.
   */
  const laidOutNodes = useMemo(() => {
    const nodes: BranchNode[] =
      edit?.kind === "draft"
        ? [
            ...doc.nodes,
            {
              createdAt: 0,
              id: DRAFT_ID,
              name: "",
              parentId: edit.parentId,
              stats: { done: 0, pending: 0, running: 0 },
              status: "idle" as const,
            },
          ]
        : doc.nodes;

    return { nodes, positions: layoutTree(nodes) };
  }, [doc.nodes, edit]);

  const flowNodes = useMemo<Node<BranchNodeData>[]>(
    () =>
      laidOutNodes.nodes.map((branch) => {
        const isDraft = branch.id === DRAFT_ID;
        const mode = (() => {
          if (isDraft) {
            return "draft" as const;
          }
          if (edit?.kind === "rename" && edit.nodeId === branch.id) {
            return "rename" as const;
          }
          return "view" as const;
        })();

        return {
          data: {
            isRoot: branch.parentId === null,
            isSelected: !isDraft && doc.selectedNodeId === branch.id,
            mode,
            name: branch.name,
            nodeId: branch.id,
            onCancelEdit: cancelEdit,
            onCommitEdit: commitEdit,
            onDelete: () => {
              const result = removeBranch(projectPath, branch.id);
              if (!result.ok) {
                setError(result.error);
              }
            },
            onStartChild: () => setEdit({ kind: "draft", parentId: branch.id }),
            projectPath,
            status: branch.status,
          },
          draggable: false,
          height: NODE_HEIGHT,
          id: branch.id,
          position: laidOutNodes.positions.get(branch.id) ?? { x: 0, y: 0 },
          selectable: !isDraft,
          type: "branch",
          width: NODE_WIDTH,
        };
      }),
    [
      cancelEdit,
      commitEdit,
      doc.selectedNodeId,
      laidOutNodes,
      projectPath,
      removeBranch,
      edit,
    ]
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      laidOutNodes.nodes
        .filter((branch) => branch.parentId !== null)
        .map((branch) => ({
          id: `${branch.parentId}->${branch.id}`,
          source: branch.parentId as string,
          target: branch.id,
          type: "smoothstep",
        })),
    [laidOutNodes]
  );

  const handleNodeDoubleClick = useCallback(
    (_event: unknown, node: { id: string }) => {
      if (node.id !== DRAFT_ID) {
        setEdit({ kind: "rename", nodeId: node.id });
      }
    },
    []
  );

  const handleNodeClick = useCallback(
    (_event: unknown, node: { id: string }) => {
      if (node.id !== DRAFT_ID) {
        selectNode(projectPath, node.id);
      }
    },
    [projectPath, selectNode]
  );

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
        onNodeDoubleClick={handleNodeDoubleClick}
        onPaneClick={cancelEdit}
        panOnScroll
        proOptions={{ hideAttribution: false }}
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
          className="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-lg border border-bw-hairline bg-bw-surface px-3 py-2 text-[12px] text-bw-ink shadow-[0_4px_12px_rgba(0,0,0,0.08)]"
          role="status"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
