import { useCallback } from "react";
import { cn } from "@/utils/tailwind";

/** How much of the parent's conversation a new branch starts with. */
export type InheritMode = "none" | "brief" | "full";

/** Keeps a click from blurring the input it sits beside, which would commit. */
function preventBlur(event: React.MouseEvent) {
  event.preventDefault();
}

/** The compact 无/简报/完整历史 segmented control offered under the draft
 * card's name input, once the parent has a conversation worth inheriting. */
export default function InheritControl({
  onChange,
  value,
}: {
  onChange: (mode: InheritMode) => void;
  value: InheritMode;
}) {
  const selectNone = useCallback(() => onChange("none"), [onChange]);
  const selectBrief = useCallback(() => onChange("brief"), [onChange]);
  const selectFull = useCallback(() => onChange("full"), [onChange]);

  return (
    <fieldset
      aria-label="Inherit conversation"
      className="m-0 flex items-center gap-1 border-0 p-0"
    >
      <InheritOption
        label="无"
        onSelect={selectNone}
        selected={value === "none"}
      />
      <InheritOption
        label="简报"
        onSelect={selectBrief}
        selected={value === "brief"}
      />
      <InheritOption
        label="完整历史"
        onSelect={selectFull}
        selected={value === "full"}
      />
    </fieldset>
  );
}

function InheritOption({
  label,
  onSelect,
  selected,
}: {
  label: string;
  onSelect: () => void;
  selected: boolean;
}) {
  return (
    <button
      aria-pressed={selected}
      className={cn(
        "rounded-full border px-1.5 py-0.5 font-mono text-[10px] transition-colors",
        selected
          ? "border-bw-accent/45 text-bw-accent"
          : "border-bw-hairline text-bw-muted hover:text-bw-ink"
      )}
      onClick={onSelect}
      onMouseDown={preventBlur}
      type="button"
    >
      {label}
    </button>
  );
}
