import { Brain, ChevronRight } from "lucide-react";
import { useCallback, useState } from "react";
import { cn } from "@/utils/tailwind";

interface ThinkingTraceProps {
  /** Seconds the turn has been thinking, if the turn is still running. */
  elapsed?: number | null;
  running?: boolean;
  text: string;
}

/**
 * The agent's reasoning, folded away.
 *
 * A disclosure rather than a `<details>`: the open state has to survive the
 * element being re-rendered on every delta, and a native summary toggles
 * itself before React hears about it, so a stream of tokens would flap it
 * shut. Collapsed by default — reasoning is available, not the answer.
 */
export default function ThinkingTrace({
  elapsed,
  running,
  text,
}: ThinkingTraceProps) {
  const [open, setOpen] = useState(false);

  const toggle = useCallback(() => {
    setOpen((was) => !was);
  }, []);

  return (
    <div className="rounded-card border border-bw-hairline bg-bw-canvas/60">
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left transition-colors duration-150 hover:bg-bw-subtle/60"
        onClick={toggle}
        type="button"
      >
        <ChevronRight
          className={cn(
            "shrink-0 text-bw-muted transition-transform duration-150",
            open && "rotate-90"
          )}
          size={12}
        />
        <Brain className="shrink-0 text-bw-muted" size={12} />
        <span
          className={cn(
            "text-[13px] text-bw-ink-2",
            // The shimmer says "still going" without a spinner taking up a
            // line of its own beside text that is already moving.
            running && "animate-pulse"
          )}
        >
          {running ? "Thinking" : "Thought"}
        </span>
        {typeof elapsed === "number" ? (
          <span className="font-mono text-[11px] text-bw-muted tabular-nums">
            {elapsed.toFixed(1)}s
          </span>
        ) : null}
      </button>

      {open ? (
        <p className="whitespace-pre-wrap px-2 pb-2 pl-[30px] text-[13px] text-bw-muted leading-relaxed">
          {text}
        </p>
      ) : null}
    </div>
  );
}
