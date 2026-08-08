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
import { useCallback, useEffect, useMemo, useRef } from "react";
import BranchNodeCard, {
  type BranchNodeData,
} from "@/components/canvas/branch-node";
import { layoutTree, NODE_HEIGHT, NODE_WIDTH } from "@/lib/branch/layout";
import { useRepoStore } from "@/stores/repo-store";
import type { CanvasNode, ParentSource } from "@/types/branch";

const nodeTypes = { branch: BranchNodeCard };

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

function CanvasInner({ nodes, projectFolder, selectedId }: BranchCanvasProps) {
  const selectNode = useRepoStore((state) => state.selectNode);

  const { fitView } = useReactFlow();
  const nodeCount = nodes.length;
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

  const positions = useMemo(() => layoutTree(nodes), [nodes]);

  const flowNodes = useMemo<Node<BranchNodeData>[]>(
    () =>
      nodes.map((node) => ({
        data: { isSelected: node.id === selectedId, node, projectFolder },
        draggable: false,
        height: NODE_HEIGHT,
        id: node.id,
        position: positions.get(node.id) ?? { x: 0, y: 0 },
        type: "branch",
        width: NODE_WIDTH,
      })),
    [nodes, positions, projectFolder, selectedId]
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      nodes
        .filter((node) => node.parentId !== null)
        .map((node) => ({
          id: `${node.parentId}->${node.id}`,
          source: node.parentId as string,
          style: { opacity: EDGE_OPACITY[node.parentSource] },
          target: node.id,
          type: "smoothstep",
        })),
    [nodes]
  );

  const handleNodeClick = useCallback(
    (_event: unknown, node: { id: string }) => {
      selectNode(projectFolder, node.id);
    },
    [projectFolder, selectNode]
  );

  const handlePaneClick = useCallback(() => {
    selectNode(projectFolder, null);
  }, [projectFolder, selectNode]);

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
    </div>
  );
}
