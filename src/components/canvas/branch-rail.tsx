import { useCallback } from "react";
import { branchLabel } from "@/components/canvas/branch-node";
import { RAIL_WIDTH } from "@/lib/branch/constants";
import { useRepoStore } from "@/stores/repo-store";
import type { CanvasNode } from "@/types/branch";
import { cn } from "@/utils/tailwind";

/**
 * What the canvas becomes while the panel is full: a flat list of branches
 * you can still switch between. The graph's geometry has no room at 200px —
 * the names do.
 */
export default function BranchRail({
  nodes,
  projectFolder,
  selectedId,
}: {
  nodes: CanvasNode[];
  projectFolder: string;
  selectedId: string | null;
}) {
  return (
    <nav
      aria-label="Branches"
      className="absolute inset-y-0 left-0 flex flex-col gap-0.5 overflow-y-auto border-bw-hairline border-r bg-bw-canvas px-2 py-3"
      style={{ width: RAIL_WIDTH }}
    >
      {nodes.map((node) => (
        <RailItem
          isSelected={node.id === selectedId}
          key={node.id}
          node={node}
          projectFolder={projectFolder}
        />
      ))}
    </nav>
  );
}

function RailItem({
  isSelected,
  node,
  projectFolder,
}: {
  isSelected: boolean;
  node: CanvasNode;
  projectFolder: string;
}) {
  const selectNode = useRepoStore((state) => state.selectNode);

  const handleClick = useCallback(() => {
    selectNode(projectFolder, node.id);
  }, [node.id, projectFolder, selectNode]);

  return (
    <button
      className={cn(
        "truncate rounded-lg px-2.5 py-1.5 text-left font-mono text-[12px] transition-colors",
        isSelected
          ? "bg-bw-surface text-bw-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
          : "text-bw-muted hover:text-bw-ink"
      )}
      onClick={handleClick}
      type="button"
    >
      {branchLabel(node)}
    </button>
  );
}
