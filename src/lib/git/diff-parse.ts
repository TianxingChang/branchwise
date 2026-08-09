import type { DiffHunk, DiffLine, FileDiff } from "@/types/diff";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Turns `git diff --patch` output into the renderer's typed model.
 *
 * Paths are read from the `---`/`+++` and `rename from`/`rename to` headers
 * rather than the `diff --git` line, because only the per-side headers are
 * unambiguous when a path contains spaces.
 */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = text.split("\n");
  let index = 0;

  while (index < lines.length) {
    if (lines[index].startsWith("diff --git ")) {
      index = parseFile(lines, index, files);
    } else {
      index += 1;
    }
  }

  return files;
}

/** Reads one file record; returns the index of the next unconsumed line. */
function parseFile(lines: string[], header: number, out: FileDiff[]): number {
  let kind: FileDiff["kind"] = "modified";
  let binary = false;
  let oldHeaderPath: string | null = null;
  let newHeaderPath: string | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;

  let index = header + 1;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith("diff --git ") || HUNK_HEADER.test(line)) {
      break;
    }
    if (line.startsWith("new file mode")) {
      kind = "added";
    } else if (line.startsWith("deleted file mode")) {
      kind = "deleted";
    } else if (line.startsWith("rename from ")) {
      renameFrom = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) {
      renameTo = line.slice("rename to ".length);
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      binary = true;
    } else if (line.startsWith("--- ")) {
      oldHeaderPath = headerPath(line.slice(4));
    } else if (line.startsWith("+++ ")) {
      newHeaderPath = headerPath(line.slice(4));
    }
  }

  const hunks: DiffHunk[] = [];
  while (index < lines.length && HUNK_HEADER.test(lines[index])) {
    index = parseHunk(lines, index, hunks);
  }

  if (renameFrom !== null && renameTo !== null) {
    kind = "renamed";
  }

  const path =
    renameTo ??
    (kind === "deleted" ? oldHeaderPath : newHeaderPath) ??
    oldHeaderPath ??
    // Binary records carry no ---/+++ headers, so the diff --git line is
    // the only path source left.
    gitLinePath(lines[header]);

  // A record with no resolvable path (a truncated or garbled patch) is
  // dropped rather than rendered as an empty row.
  if (path === null || path === undefined) {
    return index;
  }

  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const hunkLine of hunk.lines) {
      if (hunkLine.kind === "add") {
        additions += 1;
      } else if (hunkLine.kind === "del") {
        deletions += 1;
      }
    }
  }

  out.push({
    additions,
    binary,
    deletions,
    dirty: false,
    hunks,
    kind,
    oldPath: renameFrom,
    path,
  });

  return index;
}

/** Reads one `@@` section; returns the index of the next unconsumed line. */
function parseHunk(lines: string[], start: number, out: DiffHunk[]): number {
  const header = lines[start];
  const match = header.match(HUNK_HEADER);
  if (!match) {
    return start + 1;
  }

  const oldStart = Number(match[1]);
  const oldLines = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newLines = match[4] === undefined ? 1 : Number(match[4]);

  const parsed: DiffLine[] = [];
  let oldNo = oldStart;
  let newNo = newStart;

  let index = start + 1;
  for (; index < lines.length; index++) {
    const line = lines[index];

    if (line.startsWith("\\")) {
      // "\ No newline at end of file" annotates the previous line.
      continue;
    }
    if (line.startsWith("+")) {
      parsed.push({ kind: "add", newNo, oldNo: null, text: line.slice(1) });
      newNo += 1;
    } else if (line.startsWith("-")) {
      parsed.push({ kind: "del", newNo: null, oldNo, text: line.slice(1) });
      oldNo += 1;
    } else if (line.startsWith(" ") || line === "") {
      // git prefixes context with a space; a bare empty line is a blank
      // context line that lost its marker to trailing-whitespace stripping.
      parsed.push({ kind: "context", newNo, oldNo, text: line.slice(1) });
      oldNo += 1;
      newNo += 1;
    } else {
      break;
    }

    if (oldNo >= oldStart + oldLines && newNo >= newStart + newLines) {
      index += 1;
      break;
    }
  }

  // Trailing no-newline annotation for the hunk's last line.
  while (index < lines.length && lines[index].startsWith("\\")) {
    index += 1;
  }

  out.push({ header, lines: parsed, newLines, newStart, oldLines, oldStart });
  return index;
}

/**
 * Last-resort path from `diff --git a/X b/Y`. The " b/" split is ambiguous
 * for exotic paths, but this only runs for records with no other source.
 */
function gitLinePath(line: string): string | null {
  const raw = line.slice("diff --git ".length);
  const split = raw.lastIndexOf(" b/");
  if (!raw.startsWith("a/") || split === -1) {
    return null;
  }
  return raw.slice(split + 3);
}

/** Strips the a/ or b/ prefix and a path-terminating tab; null for /dev/null. */
function headerPath(raw: string): string | null {
  const path = raw.endsWith("\t") ? raw.slice(0, -1) : raw;
  if (path === "/dev/null") {
    return null;
  }
  if (path.startsWith("a/") || path.startsWith("b/")) {
    return path.slice(2);
  }
  return path;
}
