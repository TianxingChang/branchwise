import { describe, expect, test } from "vitest";
import {
  idOfKey,
  isKeyUnder,
  terminalKey,
  worktreeOfKey,
} from "@/lib/terminal/identity";

describe("terminalKey", () => {
  test("round-trips back to the worktree it was built from", () => {
    const key = terminalKey("/repo/wt/feature", "2");

    expect(worktreeOfKey(key)).toBe("/repo/wt/feature");
  });

  test("keeps two terminals of one worktree distinct", () => {
    expect(terminalKey("/repo/wt", "1")).not.toBe(terminalKey("/repo/wt", "2"));
  });

  test("survives a path containing the characters a separator might use", () => {
    // '#' and ':' are legal in POSIX filenames, so a printable separator would
    // split this path in the wrong place. NUL is the one byte that cannot.
    const awkward = "/repo/wt/feat#2::main";
    const key = terminalKey(awkward, "1");

    expect(worktreeOfKey(key)).toBe(awkward);
  });

  test("reads a bare path as its own worktree", () => {
    // Nothing writes these any more, but a key that predates the id must not
    // parse into something that fails to match its own directory.
    expect(worktreeOfKey("/repo/wt")).toBe("/repo/wt");
  });
});

describe("idOfKey", () => {
  test("recovers the id the key was built with", () => {
    expect(idOfKey(terminalKey("/repo/wt", "3"))).toBe("3");
  });

  test("is empty for a bare path, which names no terminal", () => {
    expect(idOfKey("/repo/wt")).toBe("");
  });
});

describe("isKeyUnder", () => {
  test("matches every terminal of the worktree itself", () => {
    expect(isKeyUnder(terminalKey("/repo/wt", "1"), "/repo/wt")).toBe(true);
    expect(isKeyUnder(terminalKey("/repo/wt", "7"), "/repo/wt")).toBe(true);
  });

  test("matches terminals in nested worktrees", () => {
    expect(isKeyUnder(terminalKey("/repo/wt/feature", "3"), "/repo")).toBe(
      true
    );
  });

  test("does not match a sibling that merely shares a name prefix", () => {
    // "/repo-two" starts with "/repo" as a string but is a different project;
    // closing one tab must not kill the other's shells.
    expect(isKeyUnder(terminalKey("/repo-two/wt", "1"), "/repo")).toBe(false);
  });
});
