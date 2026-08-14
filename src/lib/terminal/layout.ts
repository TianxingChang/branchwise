export type SplitOrientation = "horizontal" | "vertical";

/** The terminals sharing one pane, and which of them it is showing. */
export interface PaneGroup {
  activeId: string;
  /** Oldest first — the order the pane's tab strip lists them in. */
  terminalIds: string[];
}

/**
 * How a worktree's Terminal tab is divided.
 *
 * A tree rather than a list with a "second pane": splitting has to be
 * something you can do to *any* pane, including one that is already part of a
 * split, and only a tree composes that way.
 *
 * A split holds a *run* of panes rather than a pair. A pair would force every
 * extra pane to nest inside the last one, and nesting divides what is already
 * divided: three panes across would be a half and two quarters rather than
 * three thirds. Splitting a pane that already sits in a run of the same
 * orientation extends that run instead, so n panes across are each 1/n.
 *
 * A leaf is a *group* of terminals rather than a single one, so a pane is its
 * own tab space — you can open another shell inside a pane without dividing
 * the room any further, which is the only way to have many shells in a panel
 * too narrow to show many panes.
 */
export type PaneNode =
  | { group: PaneGroup; kind: "leaf" }
  | {
      children: PaneNode[];
      kind: "split";
      orientation: SplitOrientation;
      /**
       * One share per child. Only the ratio matters, so they are never
       * normalised on write — a drag adds to one and takes the same from its
       * neighbour, and the total stays whatever it was.
       */
      weights: number[];
    };

/**
 * The narrowest pane worth having.
 *
 * A count cap alone is not enough. The docked panel is about 54 columns wide,
 * so two panes are 26 and three are 17 — and a themed prompt that pads itself
 * to the full width overflows a 17-column pane into wrapped runs of repeated
 * characters. Splitting is refused below this, which is why the real limit is
 * the panel's width rather than any particular grid. Tabs have no such limit:
 * a new tab costs no room at all.
 */
export const MIN_PANE_COLUMNS = 20;
export const MIN_PANE_ROWS = 8;

/**
 * How many panes may share one run. Sixteen panes is the ceiling overall, and
 * four across or four down is the most that can be usable even on a display
 * where the size rule alone would still allow more.
 */
export const MAX_PANES_PER_RUN = 4;

/** Room lost to each divider between panes. */
const DIVIDER_CELLS = 1;

/**
 * The least of a run one pane may be dragged down to.
 *
 * A backstop under the divider's own clamp, which works in pixels and is the
 * one that actually matches MIN_PANE_COLUMNS. This only guarantees that no
 * path into resizeRun can leave a pane with nothing.
 */
const MIN_WEIGHT_SHARE = 0.05;

/** Equal shares, which is what a run is until someone drags a divider. */
function evenWeights(count: number): number[] {
  return Array.from({ length: count }, () => 1);
}

/** Each child's share of its run, as a fraction of the whole. */
export function fractionsOf(
  node: Extract<PaneNode, { kind: "split" }>
): number[] {
  const total = node.weights.reduce((sum, weight) => sum + weight, 0);
  return node.weights.map((weight) => weight / total);
}

/**
 * Whether a pane of this size can give up room for one more beside it.
 *
 * `run` is how many panes already share this one's run in that direction — 1
 * when the pane is not in a matching run, which is the case where splitting
 * really does halve it. Beyond that the pane is not halved at all: the run
 * re-divides, so a pane in a run of two keeps two thirds of its width. Using
 * the halving rule everywhere refuses splits that would have been fine.
 */
export function canSplit(
  size: { columns: number; rows: number },
  orientation: SplitOrientation,
  run = 1
): boolean {
  if (run >= MAX_PANES_PER_RUN) {
    return false;
  }

  const vertical = orientation === "vertical";
  const cells = vertical ? size.columns : size.rows;
  const min = vertical ? MIN_PANE_COLUMNS : MIN_PANE_ROWS;

  // This pane's measurement times however many share the run, plus the
  // dividers already between them, is the room about to be re-divided.
  const total = cells * run + (run - 1) * DIVIDER_CELLS;
  const each = Math.floor((total - run * DIVIDER_CELLS) / (run + 1));

  return each >= min;
}

/** A pane holding these terminals, showing the first. */
export function leaf(...terminalIds: string[]): PaneNode {
  return {
    group: {
      activeId: terminalIds[0] as string,
      terminalIds: [...terminalIds],
    },
    kind: "leaf",
  };
}

/** Every pane, in the order they are laid out: left to right, top to bottom. */
export function groupsOf(node: PaneNode): PaneGroup[] {
  if (node.kind === "leaf") {
    return [node.group];
  }
  return node.children.flatMap(groupsOf);
}

/** Every terminal in the layout, whether or not its pane is showing it. */
export function terminalIdsOf(node: PaneNode): string[] {
  return groupsOf(node).flatMap((group) => group.terminalIds);
}

/** The terminals a pane would show if it were on screen: one per pane. */
export function visibleIdsOf(node: PaneNode): string[] {
  return groupsOf(node).map((group) => group.activeId);
}

export function paneCount(node: PaneNode): number {
  return groupsOf(node).length;
}

function holdsTerminal(node: PaneNode, terminalId: string): boolean {
  return node.kind === "leaf" && node.group.terminalIds.includes(terminalId);
}

/**
 * A split rebuilt around new children, collapsing if too few are left.
 *
 * A run of one is not a split — it is the pane itself, promoted into its
 * parent's place. Without that, closing panes would leave dividers with
 * nothing beside them and runs that never re-widen.
 */
function withChildren(
  node: Extract<PaneNode, { kind: "split" }>,
  children: PaneNode[],
  weights: number[]
): PaneNode | null {
  if (children.length === 0) {
    return null;
  }
  if (children.length === 1) {
    return children[0] as PaneNode;
  }
  const same =
    children.length === node.children.length &&
    children.every((child, at) => child === node.children[at]);
  // A closed pane leaves its share behind: the survivors keep the sizes they
  // were dragged to, and the gap is shared out between them by the ratio.
  return same ? node : { ...node, children, weights };
}

/**
 * Applies a change to whichever leaf holds a terminal.
 *
 * Every operation below is "find the pane this terminal is in, then do
 * something to it", and returning the node unchanged by identity is what lets
 * callers tell a no-op from a change without walking the result. Null from
 * the change means the pane is gone.
 */
function mapLeafHolding(
  node: PaneNode,
  terminalId: string,
  change: (group: PaneGroup) => PaneNode | null
): PaneNode | null {
  if (node.kind === "leaf") {
    return node.group.terminalIds.includes(terminalId)
      ? change(node.group)
      : node;
  }

  const children: PaneNode[] = [];
  const weights: number[] = [];
  let changed = false;

  for (const [at, child] of node.children.entries()) {
    const next = mapLeafHolding(child, terminalId, change);
    if (next !== child) {
      changed = true;
    }
    if (next !== null) {
      children.push(next);
      weights.push(node.weights[at] as number);
    }
  }

  return changed ? withChildren(node, children, weights) : node;
}

/**
 * How many panes share a run with this terminal's pane, in one direction.
 *
 * One when the pane's own parent runs the other way — splitting then starts a
 * new run rather than joining one.
 */
export function runLengthFor(
  node: PaneNode,
  terminalId: string,
  orientation: SplitOrientation
): number {
  if (node.kind === "leaf") {
    return 1;
  }

  if (
    node.orientation === orientation &&
    node.children.some((child) => holdsTerminal(child, terminalId))
  ) {
    return node.children.length;
  }

  for (const child of node.children) {
    const found = runLengthFor(child, terminalId, orientation);
    if (found > 1) {
      return found;
    }
  }

  return 1;
}

/**
 * Divides the pane holding a terminal, the new pane beside the old one.
 *
 * Joins the run when the pane is already in one going the same way, so the
 * panes stay evenly sized. Only a split across the run's direction nests.
 */
export function splitLeaf(
  node: PaneNode,
  terminalId: string,
  orientation: SplitOrientation,
  newTerminalId: string
): PaneNode {
  if (node.kind === "leaf") {
    return node.group.terminalIds.includes(terminalId)
      ? {
          children: [node, leaf(newTerminalId)],
          kind: "split",
          orientation,
          weights: evenWeights(2),
        }
      : node;
  }

  if (node.orientation === orientation) {
    const at = node.children.findIndex((child) =>
      holdsTerminal(child, terminalId)
    );
    if (at !== -1) {
      const children = [...node.children];
      children.splice(at + 1, 0, leaf(newTerminalId));
      // Adding a pane levels the run. Keeping the old shares and squeezing one
      // in would answer "make this three" with a half and two quarters, which
      // is the shape this model exists to avoid.
      return { ...node, children, weights: evenWeights(children.length) };
    }
  }

  const children = node.children.map((child) =>
    splitLeaf(child, terminalId, orientation, newTerminalId)
  );
  return children.some((child, at) => child !== node.children[at])
    ? { ...node, children }
    : node;
}

/** Adds a tab to the pane holding a terminal, and shows it. */
export function addTab(
  node: PaneNode,
  besideTerminalId: string,
  newTerminalId: string
): PaneNode {
  const next = mapLeafHolding(node, besideTerminalId, (group) => ({
    group: {
      activeId: newTerminalId,
      terminalIds: [...group.terminalIds, newTerminalId],
    },
    kind: "leaf",
  }));
  return next ?? node;
}

/** Shows a terminal in its own pane, without disturbing any other pane. */
export function focusTerminal(node: PaneNode, terminalId: string): PaneNode {
  const next = mapLeafHolding(node, terminalId, (group) =>
    group.activeId === terminalId
      ? { group, kind: "leaf" }
      : { group: { ...group, activeId: terminalId }, kind: "leaf" }
  );
  return next ?? node;
}

/** Whichever tab a pane should show once `removed` is gone. */
function survivorOf(ids: string[], removed: string): string {
  const at = ids.indexOf(removed);
  const remaining = ids.filter((id) => id !== removed);
  return remaining[Math.min(at, remaining.length - 1)] as string;
}

/**
 * Takes a terminal out.
 *
 * Closing the last tab in a pane closes the pane, and the run closes around
 * it — the remaining panes share the space evenly again, and a run left with
 * one pane collapses into that pane. Null means the layout is now empty.
 */
export function removeTerminal(
  node: PaneNode,
  terminalId: string
): PaneNode | null {
  return mapLeafHolding(node, terminalId, (group) => {
    if (group.terminalIds.length === 1) {
      return null;
    }
    const terminalIds = group.terminalIds.filter((id) => id !== terminalId);
    return {
      group: {
        activeId:
          group.activeId === terminalId
            ? survivorOf(group.terminalIds, terminalId)
            : group.activeId,
        terminalIds,
      },
      kind: "leaf",
    };
  });
}

/**
 * The layout with only the terminals whose shells are still running,
 * collapsing around whatever went. Used to rejoin the main process's truth
 * after a remount, where a shell may have exited while nothing was watching.
 */
export function pruneTo(
  node: PaneNode,
  alive: ReadonlySet<string>
): PaneNode | null {
  if (node.kind === "leaf") {
    const terminalIds = node.group.terminalIds.filter((id) => alive.has(id));
    if (terminalIds.length === 0) {
      return null;
    }
    return {
      group: {
        activeId: terminalIds.includes(node.group.activeId)
          ? node.group.activeId
          : (terminalIds[0] as string),
        terminalIds,
      },
      kind: "leaf",
    };
  }

  const kept = node.children
    .map((child, at) => ({ at, child: pruneTo(child, alive) }))
    .filter(
      (entry): entry is { at: number; child: PaneNode } => entry.child !== null
    );

  return withChildren(
    node,
    kept.map((entry) => entry.child),
    kept.map((entry) => node.weights[entry.at] as number)
  );
}

/**
 * Moves a divider, by a fraction of the run it sits in.
 *
 * The run is addressed by its path from the root — the child indices to walk
 * — and the divider by which gap in that run it is. Naming the pane before it
 * instead reads better but is ambiguous: a subtree and its leftmost
 * descendant begin with the same terminal, so "the divider after 2" can mean
 * two different dividers in a nested layout. Indices cannot be mistaken.
 *
 * The two panes either side trade share; nothing else moves. Refusing rather
 * than clamping at the floor is what makes a drag stop dead at the limit
 * instead of creeping while the pointer keeps going.
 */
export function resizeRun(
  node: PaneNode,
  path: readonly number[],
  at: number,
  delta: number
): PaneNode {
  if (node.kind === "leaf") {
    return node;
  }

  if (path.length > 0) {
    const [head, ...rest] = path;
    const child = node.children[head as number];
    if (!child) {
      return node;
    }
    const next = resizeRun(child, rest, at, delta);
    if (next === child) {
      return node;
    }
    const children = [...node.children];
    children[head as number] = next;
    return { ...node, children };
  }

  if (at < 0 || at >= node.children.length - 1) {
    return node;
  }

  const total = node.weights.reduce((sum, weight) => sum + weight, 0);
  const shift = delta * total;
  const before = (node.weights[at] as number) + shift;
  const after = (node.weights[at + 1] as number) - shift;
  const floor = total * MIN_WEIGHT_SHARE;

  if (before < floor || after < floor) {
    return node;
  }

  const weights = [...node.weights];
  weights[at] = before;
  weights[at + 1] = after;
  return { ...node, weights };
}
