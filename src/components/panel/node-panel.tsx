import { PanelRightOpen, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import AgentTab from "@/components/panel/agent-tab";
import PlaceholderTab from "@/components/panel/placeholder-tab";
import { MAX_PANEL_WIDTH, MIN_PANEL_WIDTH } from "@/lib/branch/tree";
import { useGraphStore } from "@/stores/graph-store";
import type { BranchNode, PanelState, PanelTab } from "@/types/branch";
import { PANEL_TABS } from "@/types/branch";
import { cn } from "@/utils/tailwind";

const TAB_LABELS: Record<PanelTab, string> = {
  agent: "Agent",
  diff: "Diff",
  file: "File",
  terminal: "Terminal",
  view: "View",
};

interface NodePanelProps {
  branch: BranchNode;
  panel: PanelState;
  projectPath: string;
}

export default function NodePanel({
  branch,
  panel,
  projectPath,
}: NodePanelProps) {
  const setPanelCollapsed = useGraphStore((state) => state.setPanelCollapsed);
  const setPanelTab = useGraphStore((state) => state.setPanelTab);
  const setPanelWidth = useGraphStore((state) => state.setPanelWidth);

  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? panel.width;

  const handleResizeCommit = useCallback(
    (next: number) => {
      setDragWidth(null);
      setPanelWidth(projectPath, next);
    },
    [projectPath, setPanelWidth]
  );

  const startResize = useResizeHandle({
    onCommit: handleResizeCommit,
    onMove: setDragWidth,
    startWidth: panel.width,
  });

  const expand = useCallback(() => {
    setPanelCollapsed(projectPath, false);
  }, [projectPath, setPanelCollapsed]);

  const collapse = useCallback(() => {
    setPanelCollapsed(projectPath, true);
  }, [projectPath, setPanelCollapsed]);

  if (panel.collapsed) {
    return (
      <button
        aria-label="Show branch panel"
        className="absolute top-4 right-4 flex size-9 items-center justify-center rounded-full border border-bw-hairline bg-bw-surface text-bw-muted shadow-[0_2px_8px_rgba(0,0,0,0.07)] transition-colors hover:text-bw-ink"
        onClick={expand}
        type="button"
      >
        <PanelRightOpen size={15} />
      </button>
    );
  }

  return (
    <aside
      className="absolute top-3 right-3 bottom-3 flex flex-col overflow-hidden rounded-2xl border border-bw-hairline bg-bw-surface/95 shadow-[0_6px_24px_rgba(0,0,0,0.07)] backdrop-blur-sm"
      style={{ width }}
    >
      <div
        className="absolute top-0 bottom-0 -left-0.5 z-10 w-2 cursor-col-resize"
        onPointerDown={startResize}
      />

      <header className="flex items-center gap-2 px-4 pt-3.5 pb-3">
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-bw-ink tracking-tight">
          {branch.name}
        </span>
        <button
          aria-label="Hide branch panel"
          className="flex size-6 items-center justify-center rounded-md text-bw-muted transition-colors hover:bg-bw-subtle hover:text-bw-ink"
          onClick={collapse}
          type="button"
        >
          <X size={13} />
        </button>
      </header>

      <nav className="flex items-center gap-1 px-3 pb-3">
        {PANEL_TABS.map((tab) => (
          <TabButton
            isActive={panel.tab === tab}
            key={tab}
            onSelect={setPanelTab}
            projectPath={projectPath}
            tab={tab}
          />
        ))}
      </nav>

      <div className="min-h-0 flex-1 border-bw-hairline border-t">
        {panel.tab === "agent" ? (
          <AgentTab branch={branch} projectPath={projectPath} />
        ) : (
          <PlaceholderTab branchName={branch.name} tab={panel.tab} />
        )}
      </div>
    </aside>
  );
}

function TabButton({
  isActive,
  onSelect,
  projectPath,
  tab,
}: {
  isActive: boolean;
  onSelect: (projectPath: string, tab: PanelTab) => void;
  projectPath: string;
  tab: PanelTab;
}) {
  const handleClick = useCallback(() => {
    onSelect(projectPath, tab);
  }, [onSelect, projectPath, tab]);

  return (
    <button
      className={cn(
        "rounded-lg px-2.5 py-1 text-[12px] transition-colors",
        isActive
          ? "bg-bw-subtle text-bw-ink"
          : "text-bw-muted hover:text-bw-ink"
      )}
      onClick={handleClick}
      type="button"
    >
      {TAB_LABELS[tab]}
    </button>
  );
}

/** Drags the panel's left gutter, clamped to the same bounds the store uses. */
function useResizeHandle({
  onCommit,
  onMove,
  startWidth,
}: {
  onCommit: (width: number) => void;
  onMove: (width: number) => void;
  startWidth: number;
}) {
  const stateRef = useRef({ originWidth: startWidth, originX: 0 });

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      stateRef.current = { originWidth: startWidth, originX: event.clientX };

      let latest = startWidth;

      const handleMove = (moveEvent: PointerEvent) => {
        const delta = stateRef.current.originX - moveEvent.clientX;
        latest = Math.min(
          MAX_PANEL_WIDTH,
          Math.max(MIN_PANEL_WIDTH, stateRef.current.originWidth + delta)
        );
        onMove(latest);
      };

      const handleUp = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        onCommit(latest);
      };

      document.body.style.cursor = "col-resize";
      // Without this the drag paints a text selection across the panel.
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
    },
    [onCommit, onMove, startWidth]
  );

  useEffect(
    () => () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    },
    []
  );

  return handlePointerDown;
}
