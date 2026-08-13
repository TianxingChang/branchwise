import { Columns2, Plus, Rows2, SquareTerminal, X } from "lucide-react";
import { useCallback, useState } from "react";
import type { TerminalSize } from "@/actions/terminal";
import TerminalSurface from "@/components/panel/terminal-surface";
import {
  canSplit,
  MAX_PANES_PER_RUN,
  MIN_PANE_COLUMNS,
  MIN_PANE_ROWS,
  type PaneGroup,
  type SplitOrientation,
} from "@/lib/terminal/layout";
import { cn } from "@/utils/tailwind";

interface TerminalPaneProps {
  canClose: boolean;
  group: PaneGroup;
  isActive: boolean;
  onClose: (terminalId: string) => void;
  onFocus: (terminalId: string) => void;
  onOpenTab: (besideTerminalId: string) => void;
  onSplit: (terminalId: string, orientation: SplitOrientation) => void;
  /** The run this pane sits in: how many panes share it, and which way. */
  run?: { length: number; orientation: SplitOrientation };
  worktreePath: string;
}

/**
 * One pane: a strip of terminal tabs and whichever of them it is showing.
 *
 * The pane owns its own controls rather than a toolbar above the whole tab
 * doing it. With a layout tree, "split" and "new tab" are things you do to one
 * particular pane — and the pane is also the only thing that knows how much
 * room it has, which is what decides whether a split is worth allowing.
 */
export default function TerminalPane({
  canClose,
  group,
  isActive,
  onClose,
  onFocus,
  onOpenTab,
  onSplit,
  run,
  worktreePath,
}: TerminalPaneProps) {
  // Measured by the surface, which is the only thing that knows the cell size.
  const [size, setSize] = useState<TerminalSize>({ columns: 0, rows: 0 });

  const handleFocusPane = useCallback(() => {
    onFocus(group.activeId);
  }, [group.activeId, onFocus]);

  const handleOpenTab = useCallback(() => {
    onOpenTab(group.activeId);
  }, [group.activeId, onOpenTab]);

  // Only the pane's own parent counts: a pane sitting in a row is in a run of
  // one going down, however many rows the layout has elsewhere.
  const runLength = (orientation: SplitOrientation) =>
    run && run.orientation === orientation ? run.length : 1;

  return (
    // Focus, not click: xterm puts the caret in its own textarea when you
    // click it, and the strip's buttons focus themselves. Watching focus enter
    // the pane catches both without inventing a second notion of which pane is
    // current.
    <div
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col",
        isActive ? "bg-bw-surface" : "bg-bw-surface/60"
      )}
      onFocusCapture={handleFocusPane}
    >
      <div
        className={cn(
          "flex h-6 shrink-0 items-center gap-1 border-bw-hairline border-b pr-1 pl-1",
          isActive ? "text-bw-ink" : "text-bw-muted"
        )}
      >
        <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {group.terminalIds.map((id) => (
            <TerminalTab
              canClose={canClose || group.terminalIds.length > 1}
              id={id}
              isShown={id === group.activeId}
              key={id}
              onClose={onClose}
              onSelect={onFocus}
            />
          ))}
          <button
            aria-label="New terminal"
            className="flex size-4 shrink-0 items-center justify-center rounded text-bw-muted transition-colors hover:bg-bw-subtle hover:text-bw-ink"
            onClick={handleOpenTab}
            title="New terminal in this pane"
            type="button"
          >
            <Plus size={10} />
          </button>
        </div>

        <SplitControl
          onSplit={onSplit}
          orientation="vertical"
          run={runLength("vertical")}
          size={size}
          terminalId={group.activeId}
        />
        <SplitControl
          onSplit={onSplit}
          orientation="horizontal"
          run={runLength("horizontal")}
          size={size}
          terminalId={group.activeId}
        />
      </div>

      {/* Keyed so switching tabs builds a new xterm for the new shell rather
          than re-pointing an existing one at a different pty. */}
      <TerminalSurface
        key={group.activeId}
        onSize={setSize}
        terminalId={group.activeId}
        worktreePath={worktreePath}
      />
    </div>
  );
}

function TerminalTab({
  canClose,
  id,
  isShown,
  onClose,
  onSelect,
}: {
  canClose: boolean;
  id: string;
  isShown: boolean;
  onClose: (terminalId: string) => void;
  onSelect: (terminalId: string) => void;
}) {
  const handleSelect = useCallback(() => {
    onSelect(id);
  }, [id, onSelect]);

  const handleClose = useCallback(() => {
    onClose(id);
  }, [id, onClose]);

  return (
    // Sized like a browser tab rather than a chip: it takes a share of the
    // strip and only shrinks once several are open, down to a floor where the
    // label gives out. Below that the strip scrolls instead of squeezing them
    // into unreadable slivers.
    <div
      className={cn(
        "group flex h-5 min-w-[52px] max-w-[132px] flex-1 basis-0 items-center gap-1 rounded pr-0.5 pl-1.5 transition-colors",
        isShown ? "bg-bw-subtle text-bw-ink" : "hover:bg-bw-subtle/60"
      )}
    >
      <button
        className="flex min-w-0 flex-1 items-center gap-1 focus-visible:outline-none"
        onClick={handleSelect}
        title={`Terminal ${id}`}
        type="button"
      >
        <SquareTerminal className="shrink-0 opacity-70" size={10} />
        <span className="min-w-0 truncate text-[11px] leading-none">
          Terminal {id}
        </span>
      </button>
      {canClose ? (
        <button
          aria-label={`Close terminal ${id}`}
          className="flex size-3.5 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:text-bw-ink group-hover:opacity-60"
          onClick={handleClose}
          type="button"
        >
          <X size={9} strokeWidth={2.5} />
        </button>
      ) : null}
    </div>
  );
}

/**
 * A split button that knows whether the split is worth making.
 *
 * Disabled rather than hidden, with the reason in the tooltip: a control that
 * vanishes reads as a missing feature, where a greyed one reads as "not here,
 * not at this size". A new tab is always available — it costs no room.
 */
function SplitControl({
  onSplit,
  orientation,
  run,
  size,
  terminalId,
}: {
  onSplit: (terminalId: string, orientation: SplitOrientation) => void;
  orientation: SplitOrientation;
  run: number;
  size: TerminalSize;
  terminalId: string;
}) {
  const handleSplit = useCallback(() => {
    onSplit(terminalId, orientation);
  }, [onSplit, orientation, terminalId]);

  const vertical = orientation === "vertical";
  const allowed = canSplit(size, orientation, run);
  const Icon = vertical ? Columns2 : Rows2;
  const label = vertical ? "Split left and right" : "Split top and bottom";
  const floor = vertical
    ? `${MIN_PANE_COLUMNS} columns`
    : `${MIN_PANE_ROWS} rows`;
  const refusal =
    run >= MAX_PANES_PER_RUN
      ? `${MAX_PANES_PER_RUN} panes across is the most that stays legible.`
      : `Too small to split — each pane needs at least ${floor}.`;

  return (
    <button
      aria-label={label}
      className="flex size-4 shrink-0 items-center justify-center rounded text-bw-muted transition-colors hover:bg-bw-subtle hover:text-bw-ink disabled:pointer-events-none disabled:opacity-30"
      disabled={!allowed}
      onClick={handleSplit}
      title={allowed ? label : `${refusal} Open a tab instead.`}
      type="button"
    >
      <Icon size={10} />
    </button>
  );
}
