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

interface FileHeaders {
  binary: boolean;
  kind: FileDiff["kind"];
  newHeaderPath: string | null;
  oldHeaderPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
}

/** Reads one file record; returns the index of the next unconsumed line. */
function parseFile(lines: string[], header: number, out: FileDiff[]): number {
  const headers: FileHeaders = {
    binary: false,
    kind: "modified",
    newHeaderPath: null,
    oldHeaderPath: null,
    renameFrom: null,
    renameTo: null,
  };

  let index = header + 1;
  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith("diff --git ") || HUNK_HEADER.test(line)) {
      break;
    }
    readHeaderLine(line, headers);
    index += 1;
  }

  const hunks: DiffHunk[] = [];
  while (index < lines.length && HUNK_HEADER.test(lines[index])) {
    index = parseHunk(lines, index, hunks);
  }

  if (headers.renameFrom !== null && headers.renameTo !== null) {
    headers.kind = "renamed";
  }

  const path = resolvePath(headers, lines[header]);

  // A record with no resolvable path (a truncated or garbled patch) is
  // dropped rather than rendered as an empty row.
  if (path === null) {
    return index;
  }

  const { additions, deletions } = countLines(hunks);

  out.push({
    additions,
    binary: headers.binary,
    deletions,
    dirty: false,
    hunks,
    kind: headers.kind,
    oldPath: headers.renameFrom,
    path,
  });

  return index;
}

function readHeaderLine(line: string, headers: FileHeaders): void {
  if (line.startsWith("new file mode")) {
    headers.kind = "added";
  } else if (line.startsWith("deleted file mode")) {
    headers.kind = "deleted";
  } else if (line.startsWith("rename from ")) {
    headers.renameFrom = line.slice("rename from ".length);
  } else if (line.startsWith("rename to ")) {
    headers.renameTo = line.slice("rename to ".length);
  } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
    headers.binary = true;
  } else if (line.startsWith("--- ")) {
    headers.oldHeaderPath = headerPath(line.slice(4));
  } else if (line.startsWith("+++ ")) {
    headers.newHeaderPath = headerPath(line.slice(4));
  }
}

function resolvePath(headers: FileHeaders, gitLine: string): string | null {
  return (
    headers.renameTo ??
    (headers.kind === "deleted"
      ? headers.oldHeaderPath
      : headers.newHeaderPath) ??
    headers.oldHeaderPath ??
    // Binary records carry no ---/+++ headers, so the diff --git line is
    // the only path source left.
    gitLinePath(gitLine)
  );
}

function countLines(hunks: DiffHunk[]): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") {
        additions += 1;
      } else if (line.kind === "del") {
        deletions += 1;
      }
    }
  }
  return { additions, deletions };
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
  while (index < lines.length) {
    const line = lines[index];

    if (line.startsWith("\\")) {
      // "\ No newline at end of file" annotates the previous line.
      index += 1;
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

    index += 1;
    if (oldNo >= oldStart + oldLines && newNo >= newStart + newLines) {
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
