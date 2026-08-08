import { useCallback, useEffect } from "react";
import type { ProjectRef } from "@/actions/project";
import BranchCanvas from "@/components/canvas/branch-canvas";
import NodePanel from "@/components/panel/node-panel";
import { useRepoStore } from "@/stores/repo-store";

/** Matches the panel's own right/top/bottom inset. */
const PANEL_GUTTER = 12;

export default function ProjectWorkspace({ project }: { project: ProjectRef }) {
  const open = useRepoStore((store) => store.open);
  const close = useRepoStore((store) => store.close);
  const state = useRepoStore((store) => store.projects[project.path]);

  useEffect(() => {
    open(project.path);
    return () => close(project.path);
  }, [close, open, project.path]);

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

  const { doc, nodes } = state;
  const selected =
    nodes.find((node) => node.id === doc.selectedWorktree) ?? null;
  const panelOpen = selected !== null && !doc.panel.collapsed;
  const canvasRight = panelOpen ? doc.panel.width + PANEL_GUTTER : 0;

  return (
    <div className="relative h-full w-full bg-bw-canvas">
      <div
        className="absolute top-0 bottom-0 left-0"
        style={{ right: canvasRight }}
      >
        <BranchCanvas
          nodes={nodes}
          projectFolder={project.path}
          selectedId={doc.selectedWorktree}
        />
      </div>

      {selected ? (
        <NodePanel
          node={selected}
          panel={doc.panel}
          projectFolder={project.path}
        />
      ) : null}

      <div className="pointer-events-none absolute bottom-3 left-4 flex flex-col gap-1">
        {nodes.length === 1 ? (
          <p className="font-mono text-[11px] text-bw-muted">
            One worktree so far. Branches created anywhere show up here.
          </p>
        ) : null}
        <p className="font-mono text-[10.5px] text-bw-edge">
          {state.repo?.root ?? project.path}
        </p>
      </div>
    </div>
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
