import type React from "react";
import { Fragment, useCallback, useEffect, useRef } from "react";
import { killTerminal, listTerminals } from "@/actions/terminal";
import TerminalPane from "@/components/panel/terminal-pane";
import {
  fractionsOf,
  type PaneNode,
  type SplitOrientation,
  terminalIdsOf,
} from "@/lib/terminal/layout";
import { terminalsOf, useTerminalStore } from "@/stores/terminal-store";
import type { CanvasNode } from "@/types/branch";
import { cn } from "@/utils/tailwind";

interface TerminalTabProps {
  node: CanvasNode;
}

export default function TerminalTab({ node }: TerminalTabProps) {
  const worktreePath = node.id;
  const missing = node.prunable;

  const layout = useTerminalStore((state) => terminalsOf(state, worktreePath));
  const close = useTerminalStore((state) => state.close);
  const focus = useTerminalStore((state) => state.focus);
  const reconcile = useTerminalStore((state) => state.reconcile);
  const split = useTerminalStore((state) => state.split);
  const openTab = useTerminalStore((state) => state.openTab);
  const resize = useTerminalStore((state) => state.resize);

  // The shells are the main process's to own, so the layout is rebuilt from
  // what is actually running rather than from whatever this component last
  // remembered — it unmounts on every panel tab switch, the shells do not.
  useEffect(() => {
    if (missing) {
      return;
    }

    let active = true;

    listTerminals(worktreePath)
      .then(({ terminalIds }) => {
        if (active) {
          reconcile(worktreePath, terminalIds);
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [missing, reconcile, worktreePath]);

  const handleFocus = useCallback(
    (terminalId: string) => {
      focus(worktreePath, terminalId);
    },
    [focus, worktreePath]
  );

  const handleSplit = useCallback(
    (terminalId: string, orientation: SplitOrientation) => {
      split(worktreePath, terminalId, orientation);
    },
    [split, worktreePath]
  );

  const handleOpenTab = useCallback(
    (besideTerminalId: string) => {
      openTab(worktreePath, besideTerminalId);
    },
    [openTab, worktreePath]
  );

  const handleResize = useCallback(
    (path: readonly number[], at: number, delta: number) => {
      resize(worktreePath, path, at, delta);
    },
    [resize, worktreePath]
  );

  const handleClose = useCallback(
    (terminalId: string) => {
      // Drop the pane first so it unmounts and stops streaming before the
      // shell goes; killing underneath a live view races the teardown.
      close(worktreePath, terminalId);
      killTerminal({ terminalId, worktreePath }).catch(() => undefined);
    },
    [close, worktreePath]
  );

  if (missing) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center">
        <p className="text-[12.5px] text-bw-muted leading-relaxed">
          This worktree's directory is missing, so there is nowhere to open a
          shell. Prune it from the canvas.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 bg-bw-canvas">
      <PaneTree
        activeId={layout.activeId}
        canClose={terminalIdsOf(layout.root).length > 1}
        node={layout.root}
        onClose={handleClose}
        onFocus={handleFocus}
        onOpenTab={handleOpenTab}
        onResize={handleResize}
        onSplit={handleSplit}
        path={[]}
        worktreePath={worktreePath}
      />
    </div>
  );
}

interface PaneTreeProps {
  activeId: string;
  canClose: boolean;
  node: PaneNode;
  onClose: (terminalId: string) => void;
  onFocus: (terminalId: string) => void;
  onOpenTab: (besideTerminalId: string) => void;
  onResize: (path: readonly number[], at: number, delta: number) => void;
  onSplit: (terminalId: string, orientation: SplitOrientation) => void;
  /** Child indices from the root: this node's address for a resize. */
  path: readonly number[];
  /** The run this node sits in: how many panes share it, and which way. */
  run?: { length: number; orientation: SplitOrientation };
  worktreePath: string;
}

/**
 * Draws the layout tree.
 *
 * Recursive because the tree is: a split's child is either a terminal or
 * another split, and nothing here needs to know which until it looks.
 *
 * Every child of a run gets `flex-1` off the same basis, which is what makes
 * three panes exactly a third each. The evenness is the flat run's doing, not
 * this component's — nested pairs would render as a half and two quarters no
 * matter what these classes said.
 */
function PaneTree({ node, path, run, ...rest }: PaneTreeProps) {
  if (node.kind === "leaf") {
    return (
      // Keyed by id so re-arranging panes builds a new xterm for a new shell
      // rather than re-pointing an existing one at a different pty.
      <TerminalPane
        canClose={rest.canClose}
        group={node.group}
        isActive={node.group.terminalIds.includes(rest.activeId)}
        onClose={rest.onClose}
        onFocus={rest.onFocus}
        onOpenTab={rest.onOpenTab}
        onSplit={rest.onSplit}
        run={run}
        worktreePath={rest.worktreePath}
      />
    );
  }

  const stacked = node.orientation === "horizontal";
  const childRun = {
    length: node.children.length,
    orientation: node.orientation,
  };
  const shares = fractionsOf(node);

  return (
    <div
      className={cn(
        "flex h-full min-h-0 min-w-0",
        stacked ? "flex-col" : "flex-row"
      )}
    >
      {node.children.map((child, at) => (
        <Fragment key={firstTerminalOf(child)}>
          {at > 0 ? (
            <Divider
              at={at - 1}
              onResize={rest.onResize}
              path={path}
              share={shares[at - 1] ?? 0}
              stacked={stacked}
            />
          ) : null}
          {/* Grow by share off a zero basis, so the numbers in the tree are
              the proportions on screen and nothing else contributes. */}
          <div
            className="min-h-0 min-w-0"
            style={{ flexBasis: 0, flexGrow: shares[at] }}
          >
            <PaneTree
              node={child}
              path={[...path, at]}
              run={childRun}
              {...rest}
            />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

/**
 * Roughly MIN_PANE_COLUMNS at the terminal font's cell width, plus the pane's
 * own padding and tab strip. The clamp is in pixels because that is what the
 * pointer is in, and because the tree deals in shares that mean nothing
 * without knowing how wide the run is.
 */
const MIN_PANE_PX = 170;
const MIN_PANE_PX_STACKED = 96;

/** How far an arrow key nudges a divider. */
const KEYBOARD_STEP_PX = 16;

/**
 * The draggable boundary between two panes.
 *
 * Follows the same window-splitter pattern as the panel's own edge: a focusable
 * separator, so the boundary can be moved without a pointer and has a name to
 * be found by. A bare styled div would be invisible to anything but a mouse.
 *
 * Pointer moves report the *change since the last one* rather than the distance
 * from where the drag began: the store applies each step immediately, so by the
 * next event the panes have already moved and an absolute offset would
 * double-count.
 *
 * It refuses a step that would take either neighbour below a usable size,
 * measured from their own boxes. That is what makes a drag stop at the limit
 * rather than crushing a pane into a sliver whose prompt overflows — the same
 * floor the split gate enforces, at a different moment.
 */
function Divider({
  at,
  onResize,
  path,
  share,
  stacked,
}: {
  at: number;
  onResize: (path: readonly number[], at: number, delta: number) => void;
  path: readonly number[];
  /** How much of the run the pane before this divider holds, 0 to 1. */
  share: number;
  stacked: boolean;
}) {
  const last = useRef<number | null>(null);

  const step = useCallback(
    (divider: HTMLElement, movedPx: number) => {
      const run = divider.parentElement;
      const before = divider.previousElementSibling;
      const after = divider.nextElementSibling;
      if (!(run && before && after) || movedPx === 0) {
        return false;
      }

      const measure = (element: Element) => {
        const box = element.getBoundingClientRect();
        return stacked ? box.height : box.width;
      };

      const floor = stacked ? MIN_PANE_PX_STACKED : MIN_PANE_PX;
      if (
        measure(before) + movedPx < floor ||
        measure(after) - movedPx < floor
      ) {
        return false;
      }

      const total = measure(run);
      if (total <= 0) {
        return false;
      }

      onResize(path, at, movedPx / total);
      return true;
    },
    [at, onResize, path, stacked]
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      last.current = stacked ? event.clientY : event.clientX;
    },
    [stacked]
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (last.current === null) {
        return;
      }
      const now = stacked ? event.clientY : event.clientX;
      // Only advance the origin when the step was taken, so a refused move
      // does not silently swallow the distance the pointer travelled.
      if (step(event.currentTarget, now - last.current)) {
        last.current = now;
      }
    },
    [stacked, step]
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      event.currentTarget.releasePointerCapture(event.pointerId);
      last.current = null;
    },
    []
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      const back = stacked ? "ArrowUp" : "ArrowLeft";
      const forward = stacked ? "ArrowDown" : "ArrowRight";
      if (event.key !== back && event.key !== forward) {
        return;
      }
      event.preventDefault();
      step(
        event.currentTarget,
        event.key === forward ? KEYBOARD_STEP_PX : -KEYBOARD_STEP_PX
      );
    },
    [stacked, step]
  );

  return (
    // biome-ignore lint/a11y/useSemanticElements: the WAI-ARIA window-splitter pattern is role=separator on a focusable div; no semantic element resizes
    <div
      aria-label="Resize terminal panes"
      aria-orientation={stacked ? "horizontal" : "vertical"}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round(share * 100)}
      className={cn(
        "group relative shrink-0 outline-none focus-visible:bg-bw-accent/30",
        stacked
          ? "h-1 w-full cursor-row-resize"
          : "h-full w-1 cursor-col-resize"
      )}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      role="separator"
      tabIndex={0}
    >
      {/* A one-pixel line is the look; the target around it is what makes it
          catchable with a pointer. */}
      <div
        className={cn(
          "absolute bg-bw-hairline transition-colors group-hover:bg-bw-accent",
          stacked
            ? "inset-x-0 top-1/2 h-px -translate-y-1/2"
            : "inset-y-0 left-1/2 w-px -translate-x-1/2"
        )}
      />
    </div>
  );
}

/** A stable key for a subtree: the panes move, the terminals do not. */
function firstTerminalOf(node: PaneNode): string {
  return terminalIdsOf(node)[0] as string;
}
