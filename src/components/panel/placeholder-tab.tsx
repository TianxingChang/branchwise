import { GitCompare } from "lucide-react";
import type { PanelTab } from "@/types/branch";

interface Placeholder {
  body: string;
  icon: typeof GitCompare;
  title: string;
}

type PlaceholderTabName = Exclude<
  PanelTab,
  "agent" | "artifact" | "file" | "terminal" | "view"
>;

const PLACEHOLDERS: Record<PlaceholderTabName, Placeholder> = {
  diff: {
    body: "Every change the agent makes on {branch}, compared against the branch it grew from.",
    icon: GitCompare,
    title: "Diff",
  },
};

export default function PlaceholderTab({
  branchName,
  tab,
}: {
  branchName: string;
  tab: PlaceholderTabName;
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
