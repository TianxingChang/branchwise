import { ArrowDown, ArrowUp, FileDiff, PanelRightOpen, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { worktreeStatus } from "@/actions/repo";
import { branchLabel } from "@/components/canvas/branch-node";
import AgentTab from "@/components/panel/agent-tab";
import ArtifactTab from "@/components/panel/artifact-tab";
import FileTab from "@/components/panel/file-tab";
import PlaceholderTab from "@/components/panel/placeholder-tab";
import TerminalTab from "@/components/panel/terminal-tab";
import { MAX_PANEL_WIDTH, MIN_PANEL_WIDTH } from "@/lib/branch/constants";
import { descendantNodeIds } from "@/lib/git/resolve";
import { useRepoStore } from "@/stores/repo-store";
import type {
  CanvasNode,
  PanelState,
  PanelTab,
  WorktreeStatus,
} from "@/types/branch";
import { PANEL_TABS } from "@/types/branch";
import { cn } from "@/utils/tailwind";

const TAB_LABELS: Record<PanelTab, string> = {
  agent: "Agent",
  artifact: "Artifact",
  diff: "Diff",
  file: "File",
  terminal: "Terminal",
  view: "View",
};

interface NodePanelProps {
  node: CanvasNode;
  nodes: CanvasNode[];
  panel: PanelState;
  parentBranch: string | null;
  projectFolder: string;
}

export default function NodePanel({
  node,
  nodes,
  panel,
  parentBranch,
  projectFolder,
}: NodePanelProps) {
  const setPanelCollapsed = useRepoStore((state) => state.setPanelCollapsed);
  const setPanelTab = useRepoStore((state) => state.setPanelTab);
  const setPanelWidth = useRepoStore((state) => state.setPanelWidth);

  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? panel.width;
  const label = branchLabel(node);

  const handleResizeCommit = useCallback(
    (next: number) => {
      setDragWidth(null);
      setPanelWidth(projectFolder, next);
    },
    [projectFolder, setPanelWidth]
  );

  const startResize = useResizeHandle({
    onCommit: handleResizeCommit,
    onMove: setDragWidth,
    startWidth: panel.width,
  });

  const expand = useCallback(() => {
    setPanelCollapsed(projectFolder, false);
  }, [projectFolder, setPanelCollapsed]);

  const collapse = useCallback(() => {
    setPanelCollapsed(projectFolder, true);
  }, [projectFolder, setPanelCollapsed]);

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

      <header className="flex flex-col gap-1 px-4 pt-3.5 pb-3">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-bw-ink tracking-tight">
            {label}
          </span>
          <button
            aria-label="Hide branch panel"
            className="flex size-6 items-center justify-center rounded-md text-bw-muted transition-colors hover:bg-bw-subtle hover:text-bw-ink"
            onClick={collapse}
            type="button"
          >
            <X size={13} />
          </button>
        </div>
        <span className="truncate font-mono text-[10.5px] text-bw-edge">
          {node.id}
        </span>
        <NodeStats
          node={node}
          parentBranch={parentBranch}
          projectFolder={projectFolder}
        />
        <ParentPicker
          node={node}
          nodes={nodes}
          parentBranch={parentBranch}
          projectFolder={projectFolder}
        />
      </header>

      <nav className="flex items-center gap-1 px-3 pb-3">
        {PANEL_TABS.map((tab) => (
          <TabButton
            isActive={panel.tab === tab}
            key={tab}
            onSelect={setPanelTab}
            projectFolder={projectFolder}
            tab={tab}
          />
        ))}
      </nav>

      <div className="min-h-0 flex-1 border-bw-hairline border-t">
        <PanelBody
          branchLabel={label}
          node={node}
          projectFolder={projectFolder}
          tab={panel.tab}
        />
      </div>
    </aside>
  );
}

/**
 * Chooses which node this one hangs off.
 *
 * Dragging the edge on the canvas does the same thing, but that target is a
 * few pixels of invisible handle — this is the version you can actually hit,
 * and it is the only one that can list what the valid choices are.
 */
function ParentPicker({
  node,
  nodes,
  parentBranch,
  projectFolder,
}: {
  node: CanvasNode;
  nodes: CanvasNode[];
  parentBranch: string | null;
  projectFolder: string;
}) {
  const setParent = useRepoStore((state) => state.setParent);
  const [error, setError] = useState<string | null>(null);

  const candidates = useMemo(() => {
    const descendants = descendantNodeIds(nodes, node.id);
    return nodes.filter(
      (candidate) =>
        candidate.branch !== null &&
        candidate.id !== node.id &&
        !descendants.has(candidate.id)
    );
  }, [node.id, nodes]);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      if (!node.branch) {
        return;
      }
      const result = setParent(projectFolder, node.branch, event.target.value);
      setError(result.ok ? null : result.error);
    },
    [node.branch, projectFolder, setParent]
  );

  if (node.isRoot || !node.branch || candidates.length === 0) {
    return null;
  }

  return (
    <label className="mt-1 flex items-center gap-2 text-[11px] text-bw-muted">
      <span className="shrink-0">Branches from</span>
      <select
        className="min-w-0 flex-1 truncate rounded-md border border-bw-hairline bg-bw-surface px-1.5 py-0.5 font-mono text-[11px] text-bw-ink outline-none focus:border-bw-edge"
        onChange={handleChange}
        value={parentBranch ?? ""}
      >
        {parentBranch === null ? <option value="">unknown</option> : null}
        {candidates.map((candidate) => (
          <option key={candidate.id} value={candidate.branch as string}>
            {candidate.branch}
          </option>
        ))}
      </select>
      {error ? <span className="text-bw-pending">{error}</span> : null}
    </label>
  );
}

/**
 * Ahead/behind and dirty counts for the selected node only.
 *
 * These need `git status` and `git rev-list` inside the worktree, which is too
 * expensive to run for every node on every change — so it is read here, on
 * demand, and re-read whenever the branch's tip moves.
 */
function NodeStats({
  node,
  parentBranch,
  projectFolder,
}: {
  node: CanvasNode;
  parentBranch: string | null;
  projectFolder: string;
}) {
  const [status, setStatus] = useState<WorktreeStatus | null>(null);

  // node.head is a trigger, not a reference: the counts have to be re-read
  // whenever the branch's tip moves, not only when the node changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    let active = true;
    setStatus(null);

    worktreeStatus({
      branch: node.branch,
      parentBranch,
      path: projectFolder,
      worktreePath: node.id,
    })
      .then((result) => {
        if (active) {
          setStatus(result);
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [node.branch, node.head, node.id, parentBranch, projectFolder]);

  if (status === null) {
    return null;
  }

  if (status.ahead === 0 && status.behind === 0 && status.dirtyCount === 0) {
    return (
      <span className="text-[10.5px] text-bw-muted">
        {parentBranch ? `in sync with ${parentBranch}` : "clean"}
      </span>
    );
  }

  return (
    <span className="flex items-center gap-2.5 text-[10.5px] text-bw-muted">
      {status.ahead > 0 ? (
        <span
          className="flex items-center gap-0.5"
          title="commits ahead of parent"
        >
          <ArrowUp size={10} />
          {status.ahead}
        </span>
      ) : null}
      {status.behind > 0 ? (
        <span
          className="flex items-center gap-0.5"
          title="commits behind parent"
        >
          <ArrowDown size={10} />
          {status.behind}
        </span>
      ) : null}
      {status.dirtyCount > 0 ? (
        <span
          className="flex items-center gap-0.5 text-bw-pending"
          title="uncommitted changes"
        >
          <FileDiff size={10} />
          {status.dirtyCount}
        </span>
      ) : null}
    </span>
  );
}

function PanelBody({
  branchLabel: label,
  node,
  projectFolder,
  tab,
}: {
  branchLabel: string;
  node: CanvasNode;
  projectFolder: string;
  tab: PanelTab;
}) {
  if (tab === "agent") {
    return <AgentTab branchLabel={label} worktreePath={node.id} />;
  }

  if (tab === "file") {
    // Keyed by worktree so switching nodes starts at that worktree's root
    // rather than carrying the previous one's open file across.
    return <FileTab key={node.id} node={node} />;
  }

  if (tab === "terminal") {
    // Keyed by worktree so switching nodes gets its own shell rather than
    // re-pointing this one.
    return <TerminalTab key={node.id} node={node} />;
  }

  if (tab === "artifact") {
    // Deliberately not keyed by worktree: the shelf is the project's, and the
    // note you were writing should not vanish because you clicked a node.
    return <ArtifactTab projectFolder={projectFolder} />;
  }

  return <PlaceholderTab branchName={label} tab={tab} />;
}

function TabButton({
  isActive,
  onSelect,
  projectFolder,
  tab,
}: {
  isActive: boolean;
  onSelect: (projectFolder: string, tab: PanelTab) => void;
  projectFolder: string;
  tab: PanelTab;
}) {
  const handleClick = useCallback(() => {
    onSelect(projectFolder, tab);
  }, [onSelect, projectFolder, tab]);

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
