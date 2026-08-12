import { useCallback, useEffect, useState } from "react";
import type { ProjectRef } from "@/actions/project";
import { pruneWorktrees } from "@/actions/repo";
import BranchCanvas from "@/components/canvas/branch-canvas";
import NodePanel from "@/components/panel/node-panel";
import { PANEL_GUTTER, RAIL_WIDTH } from "@/lib/branch/constants";
import { cyclePosture } from "@/lib/branch/posture";
import { useRepoStore } from "@/stores/repo-store";
import type { PanelState } from "@/types/branch";

/**
 * How much room the panel takes from the canvas: none while peeking, its
 * width plus the window gutter while docked (the canvas ends at the floating
 * card's left edge), everything but a narrow strip while full.
 */
function canvasInset(panelOpen: boolean, panel: PanelState): number | string {
  if (!panelOpen || panel.posture === "peek") {
    return 0;
  }
  if (panel.posture === "split") {
    return panel.width + PANEL_GUTTER;
  }
  return `calc(100% - ${RAIL_WIDTH}px)`;
}

/** True when the key event began inside something that types. */
function fromEditable(event: KeyboardEvent): boolean {
  const { target } = event;
  return (
    target instanceof HTMLElement &&
    target.closest(
      'input, textarea, select, [contenteditable="true"], .xterm'
    ) !== null
  );
}

export default function ProjectWorkspace({ project }: { project: ProjectRef }) {
  const open = useRepoStore((store) => store.open);
  const close = useRepoStore((store) => store.close);
  const state = useRepoStore((store) => store.projects[project.path]);
  const setPanelPosture = useRepoStore((store) => store.setPanelPosture);

  useEffect(() => {
    open(project.path);
    return () => close(project.path);
  }, [close, open, project.path]);

  const doc = state?.doc ?? null;
  const panelVisible =
    doc !== null && doc.selectedWorktree !== null && !doc.panel.collapsed;
  const posture = doc?.panel.posture ?? null;

  // The single posture shortcut: ⌘\ (Ctrl+\ elsewhere) rotates
  // peek → split → full while the panel is up.
  useEffect(() => {
    if (!panelVisible || posture === null) {
      return;
    }

    const handleKey = (event: KeyboardEvent) => {
      if (
        event.key === "\\" &&
        (event.metaKey || event.ctrlKey) &&
        !fromEditable(event)
      ) {
        event.preventDefault();
        setPanelPosture(project.path, cyclePosture(posture));
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [panelVisible, posture, project.path, setPanelPosture]);

  if (!state || state.status === "idle" || state.status === "resolving") {
    return <WorkspaceMessage text="Reading the repository…" />;
  }

  if (state.status === "not-a-repo") {
    return <NotARepo folder={project.path} name={project.name} />;
  }

  if (state.status === "error" || !state.doc) {
    return (
      <WorkspaceMessage
        text={state.error ?? "This repository could not be read."}
      />
    );
  }

  const { nodes } = state;
  const panelDoc = state.doc;
  const selected =
    nodes.find((node) => node.id === panelDoc.selectedWorktree) ?? null;
  const panelOpen = selected !== null && !panelDoc.panel.collapsed;
  // The canvas never leaves: peek floats over it, split reserves the panel's
  // width, and full squeezes it to a narrow strip that still pans, zooms and
  // switches nodes.
  const canvasRight = canvasInset(panelOpen, panelDoc.panel);

  return (
    <div className="relative h-full w-full bg-bw-canvas">
      <div
        className="absolute top-0 bottom-0 left-0"
        style={{ right: canvasRight }}
      >
        <BranchCanvas
          nodes={nodes}
          projectFolder={project.path}
          selectedId={panelDoc.selectedWorktree}
        />
      </div>

      {selected ? (
        <NodePanel
          node={selected}
          nodes={nodes}
          panel={panelDoc.panel}
          parentBranch={
            nodes.find((node) => node.id === selected.parentId)?.branch ?? null
          }
          projectFolder={project.path}
        />
      ) : null}

      <div className="absolute bottom-3 left-4 flex flex-col items-start gap-1">
        {nodes.length === 1 ? (
          <p className="pointer-events-none font-mono text-[11px] text-bw-muted">
            One worktree so far. Branches created anywhere show up here.
          </p>
        ) : null}
        <PruneNotice
          count={nodes.filter((node) => node.prunable).length}
          folder={project.path}
        />
      </div>
    </div>
  );
}

/**
 * Git keeps listing a worktree whose directory was deleted by hand until it is
 * pruned, so the canvas offers the cleanup rather than hiding the discrepancy.
 */
function PruneNotice({ count, folder }: { count: number; folder: string }) {
  const [busy, setBusy] = useState(false);

  const handlePrune = useCallback(() => {
    setBusy(true);
    pruneWorktrees(folder).finally(() => setBusy(false));
  }, [folder]);

  if (count === 0) {
    return null;
  }

  return (
    <button
      className="rounded-md border border-bw-hairline bg-bw-surface px-2 py-1 text-[11px] text-bw-pending transition-colors hover:border-bw-edge disabled:opacity-50"
      disabled={busy}
      onClick={handlePrune}
      type="button"
    >
      {count} worktree{count === 1 ? "" : "s"} missing — prune
    </button>
  );
}

function NotARepo({ folder, name }: { folder: string; name: string }) {
  const initialize = useRepoStore((store) => store.initialize);

  const handleInit = useCallback(() => {
    initialize(folder);
  }, [folder, initialize]);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-bw-canvas">
      <div className="flex flex-col items-center gap-1.5">
        <p className="font-mono text-[13px] text-bw-ink">{name}</p>
        <p className="max-w-80 text-center text-[12.5px] text-bw-muted leading-relaxed">
          This folder is not a git repository. branchwise maps worktrees, so it
          needs one.
        </p>
      </div>
      <button
        className="rounded-xl border border-bw-hairline bg-bw-surface px-3.5 py-2 text-[12.5px] text-bw-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors hover:border-bw-edge"
        onClick={handleInit}
        type="button"
      >
        Initialize a repository here
      </button>
    </div>
  );
}

function WorkspaceMessage({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center bg-bw-canvas">
      <p className="text-[12.5px] text-bw-muted">{text}</p>
    </div>
  );
}
