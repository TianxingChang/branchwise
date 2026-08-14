import { Check, Loader2, X } from "lucide-react";
import { cn } from "@/utils/tailwind";

interface ToolChipProps {
  detail: string;
  name: string;
  /** null while the call is still running. */
  ok: boolean | null;
}

/**
 * One tool call, as a chip.
 *
 * Tool calls outnumber the sentences around them, so each one is a chip on a
 * line rather than a row of its own: a turn that reads ten files should cost
 * a couple of lines of transcript, not ten. The detail is the adapter's own
 * one-line summary — it is truncated rather than wrapped, because a chip that
 * grows to three lines has stopped being a chip.
 */
export default function ToolChip({ detail, name, ok }: ToolChipProps) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1 rounded-chip border px-1.5 py-0.5",
        "font-mono text-[11.5px] leading-[16px]",
        ok === false
          ? "border-bw-removed/30 bg-bw-removed/5 text-bw-removed"
          : "border-bw-hairline bg-bw-canvas/70 text-bw-muted"
      )}
      title={detail ? `${name} — ${detail}` : name}
    >
      {ok === null ? (
        <Loader2 className="shrink-0 animate-spin" size={9} />
      ) : null}
      {ok === true ? (
        <Check className="shrink-0 text-bw-done" size={9} />
      ) : null}
      {ok === false ? <X className="shrink-0" size={9} /> : null}
      <span className="shrink-0 text-bw-ink-2">{name}</span>
      {detail ? <span className="truncate">{detail}</span> : null}
    </span>
  );
}
