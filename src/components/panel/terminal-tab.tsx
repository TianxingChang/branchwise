import { Fragment, useCallback, useEffect } from "react";
import { killTerminal, listTerminals } from "@/actions/terminal";
import TerminalPane from "@/components/panel/terminal-pane";
import {
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
        onSplit={handleSplit}
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
  onSplit: (terminalId: string, orientation: SplitOrientation) => void;
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
function PaneTree({ node, run, ...rest }: PaneTreeProps) {
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
            <div
              className={cn(
                "shrink-0 bg-bw-hairline",
                stacked ? "h-px w-full" : "h-full w-px"
              )}
            />
          ) : null}
          <div className="min-h-0 min-w-0 flex-1 basis-0">
            <PaneTree node={child} run={childRun} {...rest} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

/** A stable key for a subtree: the panes move, the terminals do not. */
function firstTerminalOf(node: PaneNode): string {
  return terminalIdsOf(node)[0] as string;
}
