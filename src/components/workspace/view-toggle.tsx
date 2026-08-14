import { ListTree, Workflow } from "lucide-react";
import { useCallback } from "react";
import type { BranchView } from "@/types/branch";
import { cn } from "@/utils/tailwind";

/**
 * Graph or list, for the region left of the panel.
 *
 * Floats over that region's top-left rather than sitting in a bar of its own:
 * it is two small buttons, and giving them a row would cost more height than
 * the tree saves. Both options are always visible rather than one button that
 * toggles, so the mode you are in is legible without clicking to find out.
 */
export default function ViewToggle({
  onChange,
  projectFolder,
  view,
}: {
  onChange: (projectFolder: string, view: BranchView) => void;
  projectFolder: string;
  view: BranchView;
}) {
  return (
    <div className="absolute top-3 left-3 z-10 flex items-center gap-0.5 rounded-lg border border-bw-hairline bg-bw-surface/90 p-0.5 shadow-[0_1px_3px_rgba(0,0,0,0.05)] backdrop-blur-sm">
      <ViewOption
        current={view}
        label="Show branches as a graph"
        onChange={onChange}
        projectFolder={projectFolder}
        value="canvas"
      />
      <ViewOption
        current={view}
        label="Show branches as a tree"
        onChange={onChange}
        projectFolder={projectFolder}
        value="tree"
      />
    </div>
  );
}

function ViewOption({
  current,
  label,
  onChange,
  projectFolder,
  value,
}: {
  current: BranchView;
  label: string;
  onChange: (projectFolder: string, view: BranchView) => void;
  projectFolder: string;
  value: BranchView;
}) {
  const handleClick = useCallback(() => {
    onChange(projectFolder, value);
  }, [onChange, projectFolder, value]);

  const Icon = value === "canvas" ? Workflow : ListTree;
  const isActive = current === value;

  return (
    <button
      aria-label={label}
      aria-pressed={isActive}
      className={cn(
        "flex size-6 items-center justify-center rounded-md transition-colors duration-150",
        isActive
          ? "bg-bw-subtle text-bw-ink"
          : "text-bw-muted hover:bg-bw-subtle/60 hover:text-bw-ink"
      )}
      onClick={handleClick}
      title={label}
      type="button"
    >
      <Icon size={13} />
    </button>
  );
}
