import { FileCode2, GitCompare, SquareTerminal, Telescope } from "lucide-react";
import type { PanelTab } from "@/types/branch";

interface Placeholder {
  body: string;
  icon: typeof Telescope;
  title: string;
}

const PLACEHOLDERS: Record<Exclude<PanelTab, "agent">, Placeholder> = {
  diff: {
    body: "Every change the agent makes on {branch}, compared against the branch it grew from.",
    icon: GitCompare,
    title: "Diff",
  },
  file: {
    body: "Browse the working tree for {branch} and open any file the agent touched.",
    icon: FileCode2,
    title: "File",
  },
  terminal: {
    body: "A shell scoped to the {branch} worktree, with the agent's command history.",
    icon: SquareTerminal,
    title: "Terminal",
  },
  view: {
    body: "A live preview of whatever {branch} is building, refreshed as the agent works.",
    icon: Telescope,
    title: "View",
  },
};

export default function PlaceholderTab({
  branchName,
  tab,
}: {
  branchName: string;
  tab: Exclude<PanelTab, "agent">;
}) {
  const placeholder = PLACEHOLDERS[tab];
  const Icon = placeholder.icon;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2.5 px-8 text-center">
      <Icon className="text-bw-edge" size={22} strokeWidth={1.5} />
      <p className="text-[13px] text-bw-ink">{placeholder.title}</p>
      <p className="max-w-64 text-[12.5px] text-bw-muted leading-relaxed">
        {placeholder.body.replace("{branch}", branchName)}
      </p>
      <p className="mt-1 font-mono text-[10.5px] text-bw-edge uppercase tracking-wider">
        Not built yet
      </p>
    </div>
  );
}
