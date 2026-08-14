import { beforeEach, describe, expect, test } from "vitest";
import {
  groupsOf,
  MAX_PANES_PER_RUN,
  terminalIdsOf,
  visibleIdsOf,
} from "@/lib/terminal/layout";
import {
  MAX_PANES,
  terminalsOf,
  useTerminalStore,
} from "@/stores/terminal-store";

const WT = "/repo/wt/feature";

function layout(worktreePath = WT) {
  return terminalsOf(useTerminalStore.getState(), worktreePath);
}

/** One entry per pane: the terminal that pane is showing. */
function panes(worktreePath = WT) {
  return visibleIdsOf(layout(worktreePath).root);
}

/** Every terminal, whether or not its pane is showing it. */
function terminals(worktreePath = WT) {
  return terminalIdsOf(layout(worktreePath).root);
}

const store = () => useTerminalStore.getState();

describe("terminal layout", () => {
  beforeEach(() => {
    useTerminalStore.setState({ byWorktree: {} });
  });

  test("a fresh worktree shows one pane", () => {
    expect(panes()).toEqual(["1"]);
    expect(layout().activeId).toBe("1");
  });

  test("splitting adds a pane beside the one split, and focuses it", () => {
    const id = store().split(WT, "1", "vertical");

    expect(id).toBe("2");
    expect(panes()).toEqual(["1", "2"]);
    expect(layout().activeId).toBe("2");
  });

  test("a pane that is already half a split can split again", () => {
    store().split(WT, "1", "vertical");
    store().split(WT, "2", "horizontal");

    expect(panes()).toEqual(["1", "2", "3"]);
  });

  test("never reuses the id of a closed pane", () => {
    store().split(WT, "1", "vertical");
    store().close(WT, "2");

    // "2" is gone, but a pane may still be tearing down and detaching from it.
    // Handing its name to the next shell would stream one into the other.
    expect(store().split(WT, "1", "vertical")).toBe("3");
  });

  test("closing a pane collapses its split", () => {
    store().split(WT, "1", "vertical");
    store().split(WT, "2", "horizontal");
    store().close(WT, "3");

    expect(panes()).toEqual(["1", "2"]);
  });

  test("closing the focused pane focuses its neighbour", () => {
    store().split(WT, "1", "vertical");
    store().split(WT, "2", "vertical");
    store().focus(WT, "2");

    store().close(WT, "2");

    expect(panes()).toEqual(["1", "3"]);
    expect(layout().activeId).toBe("3");
  });

  test("refuses to close the last pane", () => {
    store().close(WT, "1");

    expect(panes()).toEqual(["1"]);
  });

  test("splitting a pane that is not there changes nothing", () => {
    expect(store().split(WT, "nope", "vertical")).toBeNull();
    expect(panes()).toEqual(["1"]);
  });

  test("stops a run at four across, however much room there is", () => {
    // The size rule lives in canSplit and cannot see a store with no pixels;
    // this is the other half of the limit, and the only one a test can reach.
    let last = "1";
    for (let i = 1; i < MAX_PANES_PER_RUN; i += 1) {
      last = store().split(WT, last, "vertical") as string;
    }

    expect(panes()).toHaveLength(MAX_PANES_PER_RUN);
    expect(store().split(WT, last, "vertical")).toBeNull();
    expect(panes()).toHaveLength(MAX_PANES_PER_RUN);
  });

  test("a run at its cap can still be divided the other way", () => {
    // Four across is full; four down inside one of them is a different run.
    let last = "1";
    for (let i = 1; i < MAX_PANES_PER_RUN; i += 1) {
      last = store().split(WT, last, "vertical") as string;
    }

    expect(store().split(WT, last, "horizontal")).not.toBeNull();
    expect(panes()).toHaveLength(MAX_PANES_PER_RUN + 1);
  });

  test("stops at the pane cap once the grid is full", () => {
    // Sixteen panes is four runs of four, not sixteen in a row.
    const columns = ["1"];
    for (let i = 1; i < MAX_PANES_PER_RUN; i += 1) {
      columns.push(
        store().split(WT, columns.at(-1) as string, "vertical") as string
      );
    }

    for (const column of columns) {
      let bottom = column;
      for (let i = 1; i < MAX_PANES_PER_RUN; i += 1) {
        bottom = store().split(WT, bottom, "horizontal") as string;
      }
    }

    expect(panes()).toHaveLength(MAX_PANES);
    expect(store().split(WT, "1", "horizontal")).toBeNull();
  });
});

describe("reconcile", () => {
  beforeEach(() => {
    useTerminalStore.setState({ byWorktree: {} });
  });

  test("drops panes whose shell is gone and collapses around them", () => {
    store().split(WT, "1", "vertical");
    store().split(WT, "2", "horizontal");
    expect(panes()).toEqual(["1", "2", "3"]);

    // "2" died while the panel was unmounted.
    store().reconcile(WT, ["1", "3"]);

    expect(panes()).toEqual(["1", "3"]);
  });

  test("adopts shells this mount never knew about", () => {
    // A previous mount opened these; the layout starts from nothing and still
    // has to reach them, or they are running with no way to get to them.
    store().reconcile(WT, ["1", "4", "5"]);

    expect(terminals()).toEqual(["1", "4", "5"]);
  });

  test("keeps the counter ahead of adopted names", () => {
    store().reconcile(WT, ["1", "4"]);

    expect(store().split(WT, "1", "vertical")).toBe("5");
  });

  test("keeps focus when the focused pane survived", () => {
    store().split(WT, "1", "vertical");
    store().reconcile(WT, ["1", "2"]);

    expect(layout().activeId).toBe("2");
  });

  test("moves focus when the focused pane did not survive", () => {
    store().split(WT, "1", "vertical");
    store().reconcile(WT, ["1"]);

    expect(layout().activeId).toBe("1");
  });

  test("an empty list leaves the default alone rather than blanking the tab", () => {
    // Nothing has spawned yet; the first attach will create terminal 1.
    store().reconcile(WT, []);

    expect(panes()).toEqual(["1"]);
  });
});

describe("tabs within a pane", () => {
  beforeEach(() => {
    useTerminalStore.setState({ byWorktree: {} });
  });

  test("opening a tab adds a shell without dividing the room", () => {
    const id = store().openTab(WT, "1");

    expect(id).toBe("2");
    expect(panes()).toEqual(["2"]);
    expect(terminals()).toEqual(["1", "2"]);
  });

  test("a new tab lands in the pane it was opened from", () => {
    store().split(WT, "1", "vertical");
    store().openTab(WT, "2");

    expect(groupsOf(layout().root)).toEqual([
      { activeId: "1", terminalIds: ["1"] },
      { activeId: "3", terminalIds: ["2", "3"] },
    ]);
  });

  test("focusing a hidden tab shows it in its own pane only", () => {
    store().split(WT, "1", "vertical");
    store().openTab(WT, "2");
    store().focus(WT, "2");

    expect(panes()).toEqual(["1", "2"]);
  });

  test("closing a tab keeps the pane and stays in it", () => {
    store().openTab(WT, "1");
    store().close(WT, "2");

    expect(panes()).toEqual(["1"]);
    expect(layout().activeId).toBe("1");
  });

  test("closing the last tab of a pane collapses that pane", () => {
    store().split(WT, "1", "vertical");
    store().close(WT, "2");

    expect(panes()).toEqual(["1"]);
    expect(terminals()).toEqual(["1"]);
  });

  test("never reuses an id across tabs and splits alike", () => {
    store().openTab(WT, "1");
    store().close(WT, "2");

    expect(store().split(WT, "1", "vertical")).toBe("3");
  });

  test("reconcile puts unknown shells in a pane rather than splitting", () => {
    // Adopting shells must not rearrange the room on the user's behalf.
    store().reconcile(WT, ["1", "4", "5"]);

    expect(panes()).toHaveLength(1);
    expect(terminals()).toEqual(["1", "4", "5"]);
  });
});
