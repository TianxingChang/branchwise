import type { DiffLine } from "@/types/diff";

export interface Segment {
  changed: boolean;
  text: string;
}

/** Word runs, whitespace runs, or single punctuation marks. */
const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;

/** Past this many tokens the quadratic table is not worth the paint. */
const MAX_TOKENS = 200;

/** Below this share of common tokens the pair reads as a rewrite. */
const MIN_SIMILARITY = 0.3;

/**
 * Splits a deleted/added line pair into segments, marking exactly which
 * tokens changed. Returns null when the lines share too little — painting
 * half a rewritten line as "changed words" is noisier than the whole-line
 * tint the caller falls back to.
 */
export function changedSegments(
  oldText: string,
  newText: string
): { new: Segment[]; old: Segment[] } | null {
  const oldTokens = oldText.match(TOKEN) ?? [];
  const newTokens = newText.match(TOKEN) ?? [];

  if (oldTokens.length > MAX_TOKENS || newTokens.length > MAX_TOKENS) {
    return null;
  }

  const keep = commonTokens(oldTokens, newTokens);

  const longest = Math.max(oldTokens.length, newTokens.length);
  if (longest > 0 && keep.common / longest < MIN_SIMILARITY) {
    return null;
  }

  return {
    new: toSegments(newTokens, keep.keepNew),
    old: toSegments(oldTokens, keep.keepOld),
  };
}

/** Classic LCS over tokens; flags the tokens that belong to the common run. */
function commonTokens(
  oldTokens: string[],
  newTokens: string[]
): { common: number; keepNew: boolean[]; keepOld: boolean[] } {
  const rows = oldTokens.length + 1;
  const cols = newTokens.length + 1;
  const table = new Uint16Array(rows * cols);

  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      table[row * cols + col] =
        oldTokens[row - 1] === newTokens[col - 1]
          ? table[(row - 1) * cols + (col - 1)] + 1
          : Math.max(
              table[(row - 1) * cols + col],
              table[row * cols + (col - 1)]
            );
    }
  }

  const keepOld = new Array<boolean>(oldTokens.length).fill(false);
  const keepNew = new Array<boolean>(newTokens.length).fill(false);
  let common = 0;

  let row = oldTokens.length;
  let col = newTokens.length;
  while (row > 0 && col > 0) {
    if (oldTokens[row - 1] === newTokens[col - 1]) {
      keepOld[row - 1] = true;
      keepNew[col - 1] = true;
      common += 1;
      row -= 1;
      col -= 1;
    } else if (table[(row - 1) * cols + col] >= table[row * cols + (col - 1)]) {
      row -= 1;
    } else {
      col -= 1;
    }
  }

  return { common, keepNew, keepOld };
}

/** Fuses adjacent tokens with the same fate into render-ready segments. */
function toSegments(tokens: string[], keep: boolean[]): Segment[] {
  const segments: Segment[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const changed = !keep[index];
    const last = segments.at(-1);
    if (last && last.changed === changed) {
      last.text += tokens[index];
    } else {
      segments.push({ changed, text: tokens[index] });
    }
  }
  return segments;
}

/**
 * Pairs each run of deleted lines with the run of added lines that follows
 * it, index for index — the shape `git diff` emits for an edited block. The
 * pairs are what intra-line comparison runs on.
 */
export function pairChangedLines(lines: DiffLine[]): [number, number][] {
  const pairs: [number, number][] = [];

  let index = 0;
  while (index < lines.length) {
    if (lines[index].kind !== "del") {
      index += 1;
      continue;
    }

    const delStart = index;
    while (index < lines.length && lines[index].kind === "del") {
      index += 1;
    }
    const addStart = index;
    while (index < lines.length && lines[index].kind === "add") {
      index += 1;
    }

    const paired = Math.min(addStart - delStart, index - addStart);
    for (let offset = 0; offset < paired; offset += 1) {
      pairs.push([delStart + offset, addStart + offset]);
    }
  }

  return pairs;
}
