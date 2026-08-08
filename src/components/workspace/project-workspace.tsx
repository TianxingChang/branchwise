import { useEffect } from "react";
import type { ProjectRef } from "@/actions/project";
import BranchCanvas from "@/components/canvas/branch-canvas";
import NodePanel from "@/components/panel/node-panel";
import { useGraphStore } from "@/stores/graph-store";

/** Matches the panel's own right/top/bottom inset. */
const PANEL_GUTTER = 12;

export default function ProjectWorkspace({ project }: { project: ProjectRef }) {
  const load = useGraphStore((store) => store.load);
  const graph = useGraphStore((store) => store.projects[project.path]);

  useEffect(() => {
    load(project.path);
  }, [load, project.path]);

  if (!graph || graph.status === "loading" || graph.status === "idle") {
    return <WorkspaceMessage text="Loading branches…" />;
  }

  const { doc } = graph;

  if (graph.status === "error" || !doc) {
    return (
      <WorkspaceMessage
        text={graph.error ?? "This project's graph could not be read."}
      />
    );
  }

  const selected =
    doc.nodes.find((node) => node.id === doc.selectedNodeId) ?? doc.nodes[0];

  // The canvas stops where the panel starts. Letting React Flow run full-bleed
  // would park freshly created branches underneath the panel, and fitView would
  // happily centre on space the user cannot see.
  const canvasRight = doc.panel.collapsed ? 0 : doc.panel.width + PANEL_GUTTER;

  return (
    <div className="relative h-full w-full bg-bw-canvas">
      <div
        className="absolute top-0 bottom-0 left-0"
        style={{ right: canvasRight }}
      >
        <BranchCanvas doc={doc} projectPath={project.path} />
      </div>

      <NodePanel
        branch={selected}
        panel={doc.panel}
        projectPath={project.path}
      />

      <div className="pointer-events-none absolute bottom-3 left-4 flex flex-col gap-1">
        {doc.nodes.length === 1 ? (
          <p className="font-mono text-[11px] text-bw-muted">
            Hover a branch and press + to branch from it.
          </p>
        ) : null}
        <p className="font-mono text-[10.5px] text-bw-edge">{project.path}</p>
      </div>
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
