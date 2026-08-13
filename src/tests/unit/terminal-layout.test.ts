import { describe, expect, test } from "vitest";
import {
  addTab,
  canSplit,
  focusTerminal,
  fractionsOf,
  groupsOf,
  leaf,
  MAX_PANES_PER_RUN,
  type PaneNode,
  paneCount,
  pruneTo,
  removeTerminal,
  resizeRun,
  runLengthFor,
  splitLeaf,
  terminalIdsOf,
  visibleIdsOf,
} from "@/lib/terminal/layout";

/** "1" split beside "2", with "2" further split above "3". */
function nested(): PaneNode {
  return splitLeaf(
    splitLeaf(leaf("1"), "1", "vertical", "2"),
    "2",
    "horizontal",
    "3"
  );
}

describe("groups", () => {
  test("a fresh pane holds one terminal and shows it", () => {
    expect(groupsOf(leaf("1"))).toEqual([
      { activeId: "1", terminalIds: ["1"] },
    ]);
  });

  test("reads panes left to right, top to bottom", () => {
    expect(visibleIdsOf(nested())).toEqual(["1", "2", "3"]);
  });

  test("counts panes, not terminals", () => {
    const tree = addTab(leaf("1"), "1", "9");

    expect(paneCount(tree)).toBe(1);
    expect(terminalIdsOf(tree)).toEqual(["1", "9"]);
  });
});

describe("addTab", () => {
  test("adds a terminal to the pane holding another, and shows it", () => {
    const tree = addTab(leaf("1"), "1", "2");

    expect(groupsOf(tree)).toEqual([
      { activeId: "2", terminalIds: ["1", "2"] },
    ]);
  });

  test("adds to the pane the terminal is in, not the first one", () => {
    const tree = addTab(nested(), "3", "4");

    expect(visibleIdsOf(tree)).toEqual(["1", "2", "4"]);
    expect(paneCount(tree)).toBe(3);
  });

  test("a hidden tab still counts as being in its pane", () => {
    // "2" is behind "4" in its pane; opening beside it must land there.
    const tree = addTab(addTab(leaf("1"), "1", "2"), "1", "4");

    expect(paneCount(tree)).toBe(1);
    expect(terminalIdsOf(tree)).toEqual(["1", "2", "4"]);
  });

  test("leaves the tree alone when the terminal is not in it", () => {
    const before = nested();

    expect(addTab(before, "nope", "9")).toBe(before);
  });
});

describe("splitLeaf", () => {
  test("replaces the pane with a pair", () => {
    expect(visibleIdsOf(splitLeaf(leaf("1"), "1", "vertical", "2"))).toEqual([
      "1",
      "2",
    ]);
  });

  test("splits a pane nested deep in the tree", () => {
    expect(visibleIdsOf(splitLeaf(nested(), "3", "vertical", "4"))).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
  });

  test("the new pane lands beside the one that was split, not at the end", () => {
    expect(visibleIdsOf(splitLeaf(nested(), "1", "vertical", "4"))).toEqual([
      "1",
      "4",
      "2",
      "3",
    ]);
  });

  test("a split carries the pane's other tabs along with it", () => {
    // Splitting takes the pane you are in — including tabs it is not showing —
    // and puts a new, separate pane beside it.
    const tree = splitLeaf(addTab(leaf("1"), "1", "2"), "1", "vertical", "3");

    expect(groupsOf(tree)).toEqual([
      { activeId: "2", terminalIds: ["1", "2"] },
      { activeId: "3", terminalIds: ["3"] },
    ]);
  });

  test("leaves the tree alone when the terminal is not in it", () => {
    const before = nested();

    expect(splitLeaf(before, "nope", "vertical", "9")).toBe(before);
  });
});

describe("focusTerminal", () => {
  test("shows a hidden tab in its own pane", () => {
    const tree = focusTerminal(addTab(leaf("1"), "1", "2"), "1");

    expect(visibleIdsOf(tree)).toEqual(["1"]);
  });

  test("does not disturb the other panes", () => {
    const tree = focusTerminal(addTab(nested(), "1", "4"), "1");

    expect(visibleIdsOf(tree)).toEqual(["1", "2", "3"]);
  });
});

describe("removeTerminal", () => {
  test("closing a tab leaves the pane, showing a neighbour", () => {
    const tree = removeTerminal(addTab(leaf("1"), "1", "2"), "2") as PaneNode;

    expect(groupsOf(tree)).toEqual([{ activeId: "1", terminalIds: ["1"] }]);
  });

  test("closing the last tab in a pane collapses the split", () => {
    // The whole point: closing one half must not leave a half-empty split.
    const tree = splitLeaf(leaf("1"), "1", "vertical", "2");

    expect(visibleIdsOf(removeTerminal(tree, "2") as PaneNode)).toEqual(["1"]);
  });

  test("promotes a whole subtree when the sibling is itself split", () => {
    const tree = removeTerminal(nested(), "1") as PaneNode;

    expect(visibleIdsOf(tree)).toEqual(["2", "3"]);
    expect(paneCount(tree)).toBe(2);
  });

  test("a pane with other tabs survives losing the one on screen", () => {
    const tree = removeTerminal(
      splitLeaf(addTab(leaf("1"), "1", "2"), "1", "vertical", "3"),
      "2"
    ) as PaneNode;

    expect(groupsOf(tree)).toEqual([
      { activeId: "1", terminalIds: ["1"] },
      { activeId: "3", terminalIds: ["3"] },
    ]);
  });

  test("removing the only terminal leaves nothing", () => {
    expect(removeTerminal(leaf("1"), "1")).toBeNull();
  });

  test("leaves the tree alone when the terminal is not in it", () => {
    const before = nested();

    expect(removeTerminal(before, "nope")).toBe(before);
  });
});

describe("pruneTo", () => {
  test("drops panes whose shells are gone and collapses around them", () => {
    expect(
      visibleIdsOf(pruneTo(nested(), new Set(["1", "3"])) as PaneNode)
    ).toEqual(["1", "3"]);
  });

  test("drops a dead tab but keeps its pane alive", () => {
    const tree = pruneTo(
      addTab(leaf("1"), "1", "2"),
      new Set(["1"])
    ) as PaneNode;

    expect(groupsOf(tree)).toEqual([{ activeId: "1", terminalIds: ["1"] }]);
  });

  test("keeps the tree when every terminal survived", () => {
    expect(
      terminalIdsOf(pruneTo(nested(), new Set(["1", "2", "3"])) as PaneNode)
    ).toEqual(["1", "2", "3"]);
  });

  test("is empty when nothing survived", () => {
    expect(pruneTo(nested(), new Set())).toBeNull();
  });
});

describe("canSplit", () => {
  test("allows a split that leaves both halves usable", () => {
    expect(canSplit({ columns: 54, rows: 32 }, "vertical")).toBe(true);
  });

  test("refuses a split that would make a pane too narrow to draw a prompt", () => {
    // 26 columns halves to 12 — below what a themed prompt can render, which
    // is the garbling this gate exists to prevent.
    expect(canSplit({ columns: 26, rows: 32 }, "vertical")).toBe(false);
  });

  test("gates height on rows, independently of width", () => {
    expect(canSplit({ columns: 54, rows: 32 }, "horizontal")).toBe(true);
    expect(canSplit({ columns: 54, rows: 12 }, "horizontal")).toBe(false);
  });
});

describe("runs", () => {
  /** Three panes across, made the way a user makes them: split, split again. */
  function threeAcross(): PaneNode {
    return splitLeaf(
      splitLeaf(leaf("1"), "1", "vertical", "2"),
      "2",
      "vertical",
      "3"
    );
  }

  test("splitting the same way again extends the run instead of nesting", () => {
    // Nesting would give a half and two quarters. A run gives three thirds,
    // because flex divides one list evenly and cannot divide a nested pair.
    expect(runLengthFor(threeAcross(), "1", "vertical")).toBe(3);
    expect(runLengthFor(threeAcross(), "3", "vertical")).toBe(3);
  });

  test("the extended run keeps the panes in the order they were made", () => {
    expect(visibleIdsOf(threeAcross())).toEqual(["1", "2", "3"]);
  });

  test("splitting a middle pane inserts beside it, not at the end", () => {
    const four = splitLeaf(threeAcross(), "1", "vertical", "9");

    expect(visibleIdsOf(four)).toEqual(["1", "9", "2", "3"]);
    expect(runLengthFor(four, "9", "vertical")).toBe(4);
  });

  test("splitting across the run still nests", () => {
    // A pane divided the other way is its own two-pane run inside the first.
    const tree = splitLeaf(threeAcross(), "2", "horizontal", "4");

    expect(runLengthFor(tree, "2", "horizontal")).toBe(2);
    expect(runLengthFor(tree, "2", "vertical")).toBe(1);
    expect(runLengthFor(tree, "1", "vertical")).toBe(3);
  });

  test("a pane not in a run of that orientation reports a run of one", () => {
    expect(runLengthFor(leaf("1"), "1", "vertical")).toBe(1);
    expect(runLengthFor(threeAcross(), "1", "horizontal")).toBe(1);
  });

  test("closing one of three leaves a run of two, not a collapsed tree", () => {
    const left = removeTerminal(threeAcross(), "2");

    expect(left && visibleIdsOf(left)).toEqual(["1", "3"]);
    expect(left && runLengthFor(left, "1", "vertical")).toBe(2);
  });

  test("closing down to one pane collapses the run away", () => {
    const two = removeTerminal(threeAcross(), "2");
    const one = two && removeTerminal(two, "3");

    expect(one && visibleIdsOf(one)).toEqual(["1"]);
    expect(one && runLengthFor(one, "1", "vertical")).toBe(1);
  });
});

describe("canSplit across a run", () => {
  const tall = { columns: 54, rows: 40 };

  test("measures against the run, not against halving the pane", () => {
    // A pane in a run of two is not halved by another split: the run
    // re-divides, so it keeps two thirds. Judging it as a halving would
    // refuse splits that are perfectly usable.
    const inRun = { columns: 40, rows: 40 };

    expect(canSplit(inRun, "vertical", 2)).toBe(true);
    // The very same pane, judged as though it were about to be halved, is
    // refused: 40 columns -> 19, under the minimum. Same pixels, and the
    // denominator is the whole difference.
    expect(canSplit(inRun, "vertical", 1)).toBe(false);
    // Narrow enough that halving fails but re-dividing a run still works.
    expect(canSplit({ columns: 31, rows: 40 }, "vertical", 1)).toBe(false);
    expect(canSplit({ columns: 31, rows: 40 }, "vertical", 2)).toBe(true);
  });

  test("refuses once the run is as wide as it is allowed to get", () => {
    // Even with room to spare: four across is the most that stays legible.
    expect(
      canSplit({ columns: 400, rows: 200 }, "vertical", MAX_PANES_PER_RUN)
    ).toBe(false);
    expect(
      canSplit({ columns: 400, rows: 200 }, "vertical", MAX_PANES_PER_RUN - 1)
    ).toBe(true);
  });

  test("a third pane is refused in the docked panel, where it would be 17 columns", () => {
    // 54 columns whole, 26 once split. A third would be 17 — below what a
    // padded prompt can draw, which is the garbling this rule exists to stop.
    expect(canSplit(tall, "vertical", 1)).toBe(true);
    expect(canSplit({ columns: 26, rows: 40 }, "vertical", 2)).toBe(false);
  });
});

describe("resizeRun", () => {
  /** Three panes across, evenly shared until something drags them. */
  function threeAcross(): PaneNode {
    return splitLeaf(
      splitLeaf(leaf("1"), "1", "vertical", "2"),
      "2",
      "vertical",
      "3"
    );
  }

  function shares(node: PaneNode): number[] {
    if (node.kind === "leaf") {
      throw new Error("not a run");
    }
    return fractionsOf(node).map((fraction) => Math.round(fraction * 100));
  }

  test("a fresh run is shared evenly", () => {
    expect(shares(threeAcross())).toEqual([33, 33, 33]);
  });

  test("a drag moves share between the two panes it sits between", () => {
    const wider = resizeRun(threeAcross(), [], 0, 0.1);

    // The third pane is untouched: a divider is between two panes, and the
    // rest of the run has no business moving because one of them grew.
    expect(shares(wider)).toEqual([43, 23, 33]);
  });

  test("dragging the other way gives the share back", () => {
    const there = resizeRun(threeAcross(), [], 0, 0.1);
    const back = resizeRun(there, [], 0, -0.1);

    expect(shares(back)).toEqual([33, 33, 33]);
  });

  test("refuses a drag that would leave a pane with nothing", () => {
    const before = threeAcross();

    // Refusing rather than clamping is what makes a drag stop dead at the
    // limit instead of creeping on while the pointer keeps moving.
    expect(resizeRun(before, [], 0, 0.9)).toBe(before);
    expect(resizeRun(before, [], 0, -0.9)).toBe(before);
  });

  test("there is no divider after the last pane", () => {
    const before = threeAcross();

    expect(resizeRun(before, [], 2, 0.1)).toBe(before);
  });

  test("addresses a run that is not there and nothing moves", () => {
    const before = threeAcross();

    expect(resizeRun(before, [7], 0, 0.1)).toBe(before);
  });

  test("reaches a divider nested inside another run", () => {
    // The outer run is vertical; "2" is split into its own horizontal run.
    const tree = splitLeaf(threeAcross(), "2", "horizontal", "4");
    // Child 1 of the outer run is the horizontal run holding "2" and "4".
    const dragged = resizeRun(tree, [1], 0, 0.2);

    expect(dragged).not.toBe(tree);
    // The outer run keeps its thirds — only the inner divider moved.
    expect(shares(dragged)).toEqual([33, 33, 33]);
  });

  test("adding a pane levels the run again", () => {
    const dragged = resizeRun(
      splitLeaf(leaf("1"), "1", "vertical", "2"),
      [],
      0,
      0.2
    );
    expect(shares(dragged)).toEqual([70, 30]);

    // "Make this three" should answer with thirds, not with the old ratio
    // squeezed to make room.
    expect(shares(splitLeaf(dragged, "2", "vertical", "3"))).toEqual([
      33, 33, 33,
    ]);
  });

  test("closing a pane leaves its share to the survivors, by ratio", () => {
    const dragged = resizeRun(threeAcross(), [], 0, 0.1);
    const left = removeTerminal(dragged, "2");

    // 43 and 33 of the run remain; they keep their relative sizes.
    expect(left && shares(left)).toEqual([57, 43]);
  });
});
