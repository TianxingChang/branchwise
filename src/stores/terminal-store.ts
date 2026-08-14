import { create } from "zustand";
import {
  addTab,
  focusTerminal,
  groupsOf,
  leaf,
  MAX_PANES_PER_RUN,
  type PaneNode,
  paneCount,
  pruneTo,
  removeTerminal,
  resizeRun,
  runLengthFor,
  type SplitOrientation,
  splitLeaf,
  terminalIdsOf,
  visibleIdsOf,
} from "@/lib/terminal/layout";

export type { SplitOrientation } from "@/lib/terminal/layout";

/**
 * A backstop, not the real limit. What actually stops you splitting is whether
 * the resulting pane could still render a shell — see MIN_PANE_COLUMNS. This
 * only guards against a layout no one meant to build. Tabs are uncapped: one
 * costs no room.
 */
export const MAX_PANES = 16;

export interface WorktreeTerminals {
  /** The terminal with the keyboard, and the one new tabs open beside. */
  activeId: string;
  /** How the tab is divided, and which terminals sit in each pane. */
  root: PaneNode;
  /** The highest id ever issued here. Only ever climbs; see issueId. */
  sequence: number;
}

interface TerminalLayoutState {
  /** Worktree path → how its Terminal tab is arranged. */
  byWorktree: Record<string, WorktreeTerminals>;
  close: (worktreePath: string, terminalId: string) => void;
  focus: (worktreePath: string, terminalId: string) => void;
  /** Opens a shell as another tab of the pane holding `besideTerminalId`. */
  openTab: (worktreePath: string, besideTerminalId: string) => string | null;
  /** Replaces the layout with what the main process actually has running. */
  reconcile: (worktreePath: string, ids: string[]) => void;
  /**
   * Moves a divider by a fraction of its run. The run is addressed by its
   * path from the root, the divider by which gap in that run it is.
   */
  resize: (
    worktreePath: string,
    path: readonly number[],
    at: number,
    delta: number
  ) => void;
  /** Divides a pane in two. Returns the new terminal's id, or null if capped. */
  split: (
    worktreePath: string,
    terminalId: string,
    orientation: SplitOrientation
  ) => string | null;
}

const EMPTY: WorktreeTerminals = {
  activeId: "1",
  root: leaf("1"),
  sequence: 1,
};

function stateOf(
  layout: Record<string, WorktreeTerminals>,
  worktreePath: string
): WorktreeTerminals {
  return layout[worktreePath] ?? EMPTY;
}

/**
 * Issues an id that has never been used here before.
 *
 * Counted rather than derived from the live terminals: closing one frees its
 * name, and a derived id would hand that name straight to the next shell. A
 * view still tearing down from the closed one would then reattach to the new
 * shell and stream it into something about to be thrown away.
 */
function issueId(current: WorktreeTerminals): { id: string; sequence: number } {
  const sequence = current.sequence + 1;
  return { id: String(sequence), sequence };
}

function highestOf(ids: string[]): number {
  return ids.reduce(
    (max, id) => Math.max(max, Number.parseInt(id, 10) || 0),
    0
  );
}

/**
 * Where focus lands once a terminal is gone.
 *
 * Prefers whatever its own pane now shows, so closing a tab keeps you where
 * you were working; only a pane that vanished entirely moves you elsewhere.
 */
function focusAfterClose(
  before: PaneNode,
  after: PaneNode,
  closed: string,
  active: string
): string {
  if (terminalIdsOf(after).includes(active)) {
    return active;
  }

  const paneWas = groupsOf(before).findIndex((group) =>
    group.terminalIds.includes(closed)
  );
  const siblings = (groupsOf(before)[paneWas]?.terminalIds ?? []).filter(
    (id) => id !== closed
  );
  const samePane = groupsOf(after).find((group) =>
    siblings.some((id) => group.terminalIds.includes(id))
  );
  if (samePane) {
    return samePane.activeId;
  }

  // The pane itself is gone, so fall to whichever pane now occupies roughly
  // where it was. Jumping to the first pane in the layout would throw you
  // across the panel for closing something on the far side.
  const remaining = visibleIdsOf(after);
  return remaining[Math.min(paneWas, remaining.length - 1)] as string;
}

/**
 * The layout to show for the shells the main process actually has running.
 *
 * Keeps whatever of the old arrangement still applies, then folds in shells it
 * has never seen — spawned by an earlier mount this one did not inherit — as
 * tabs of the first pane. As tabs, not splits: adopting a shell must not
 * rearrange the room on the user's behalf.
 */
function adoptedLayout(
  previous: WorktreeTerminals | undefined,
  ids: string[]
): PaneNode {
  const kept = previous ? pruneTo(previous.root, new Set(ids)) : null;
  const already = new Set(kept ? terminalIdsOf(kept) : []);
  const unplaced = ids.filter((id) => !already.has(id));

  if (!kept) {
    // The first unplaced shell becomes the layout and the rest join it.
    // Seeding from it *and* folding it in would show it twice, which is two
    // views racing to drive one pty.
    const [first, ...rest] = unplaced;
    return rest.reduce<PaneNode>(
      (tree, id) => addTab(tree, first as string, id),
      leaf(first as string)
    );
  }

  const anchor = terminalIdsOf(kept)[0] as string;
  return unplaced.reduce<PaneNode>(
    (tree, id) => addTab(tree, anchor, id),
    kept
  );
}

/**
 * How each worktree's Terminal tab is arranged: which panes it is divided
 * into, which terminals sit in each pane, and which one has the keyboard.
 *
 * Arrangement only. Which shells *exist* is the main process's to know — it
 * owns the ptys — so this is reconciled against it on mount rather than
 * persisted. Deliberately not in localStorage either: a pty cannot survive
 * quit, so restoring a layout would promise state the shells no longer have.
 */
export const useTerminalStore = create<TerminalLayoutState>()((set, get) => ({
  byWorktree: {},

  close: (worktreePath, terminalId) =>
    set((state) => {
      const current = stateOf(state.byWorktree, worktreePath);
      // The tab always shows a terminal; closing the last one is a restart in
      // disguise, and an empty tab would leave nothing to click to get back.
      if (terminalIdsOf(current.root).length <= 1) {
        return state;
      }

      const root = removeTerminal(current.root, terminalId);
      if (root === null || root === current.root) {
        return state;
      }

      return {
        byWorktree: {
          ...state.byWorktree,
          [worktreePath]: {
            ...current,
            activeId: focusAfterClose(
              current.root,
              root,
              terminalId,
              current.activeId
            ),
            root,
          },
        },
      };
    }),

  focus: (worktreePath, terminalId) =>
    set((state) => {
      const current = stateOf(state.byWorktree, worktreePath);
      const root = focusTerminal(current.root, terminalId);
      if (root === current.root && current.activeId === terminalId) {
        return state;
      }
      return {
        byWorktree: {
          ...state.byWorktree,
          [worktreePath]: { ...current, activeId: terminalId, root },
        },
      };
    }),

  openTab: (worktreePath, besideTerminalId) => {
    const current = stateOf(get().byWorktree, worktreePath);
    const { id, sequence } = issueId(current);
    const root = addTab(current.root, besideTerminalId, id);
    if (root === current.root) {
      return null;
    }

    set((state) => ({
      byWorktree: {
        ...state.byWorktree,
        [worktreePath]: {
          ...stateOf(state.byWorktree, worktreePath),
          activeId: id,
          root,
          sequence,
        },
      },
    }));

    return id;
  },

  reconcile: (worktreePath, ids) =>
    set((state) => {
      const current = state.byWorktree[worktreePath];
      // Nothing running yet: the first attach creates terminal 1, so keep the
      // default rather than blanking a tab that is about to spawn one.
      if (ids.length === 0) {
        return state;
      }

      const root = adoptedLayout(current, ids);
      const placed = terminalIdsOf(root);

      return {
        byWorktree: {
          ...state.byWorktree,
          [worktreePath]: {
            activeId: placed.includes(current?.activeId ?? "")
              ? (current?.activeId as string)
              : (visibleIdsOf(root)[0] as string),
            root,
            // Adopted shells were named by a previous mount, so the counter
            // has to clear them before it issues anything of its own.
            sequence: Math.max(current?.sequence ?? 0, highestOf(placed)),
          },
        },
      };
    }),

  resize: (worktreePath, path, at, delta) =>
    set((state) => {
      const current = stateOf(state.byWorktree, worktreePath);
      const root = resizeRun(current.root, path, at, delta);
      if (root === current.root) {
        return state;
      }
      return {
        byWorktree: {
          ...state.byWorktree,
          [worktreePath]: { ...current, root },
        },
      };
    }),

  split: (worktreePath, terminalId, orientation) => {
    const current = stateOf(get().byWorktree, worktreePath);
    if (paneCount(current.root) >= MAX_PANES) {
      return null;
    }
    // The button is already disabled at the cap, but the rule belongs here
    // too: a keyboard shortcut or a stale render must not be able to grow a
    // run past what stays legible.
    if (
      runLengthFor(current.root, terminalId, orientation) >= MAX_PANES_PER_RUN
    ) {
      return null;
    }

    const { id, sequence } = issueId(current);
    const root = splitLeaf(current.root, terminalId, orientation, id);
    if (root === current.root) {
      return null;
    }

    set((state) => ({
      byWorktree: {
        ...state.byWorktree,
        [worktreePath]: {
          ...stateOf(state.byWorktree, worktreePath),
          // Focus follows the split, the way it does in every terminal that
          // has them — you split because you want to type in the new one.
          activeId: id,
          root,
          sequence,
        },
      },
    }));

    return id;
  },
}));

/** Read-only view of one worktree's arrangement, defaulted for a fresh tab. */
export function terminalsOf(
  state: TerminalLayoutState,
  worktreePath: string
): WorktreeTerminals {
  return stateOf(state.byWorktree, worktreePath);
}
