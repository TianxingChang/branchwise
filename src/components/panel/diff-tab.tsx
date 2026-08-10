import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { readTextFile } from "@/actions/files";
import { worktreeDiff } from "@/actions/repo";
import { languageForFile } from "@/lib/files/language";
import { type CodeToken, highlightCodeTokens } from "@/lib/files/shiki";
import {
  changedSegments,
  pairChangedLines,
  type Segment,
} from "@/lib/git/intra-line";
import type { CanvasNode } from "@/types/branch";
import type { DiffLine, FileDiff, WorktreeDiff } from "@/types/diff";
import { cn } from "@/utils/tailwind";

/** A single file past this many changed lines starts collapsed. */
const COLLAPSE_FILE_OVER = 400;
/** Past either bound, every file starts collapsed behind a hint. */
const COLLAPSE_ALL_LINES = 600;
const COLLAPSE_ALL_FILES = 15;

type Remote =
  | { status: "loading" }
  | { error: string; status: "error" }
  | { diff: WorktreeDiff; status: "ready" };

interface DiffTabProps {
  node: CanvasNode;
  parentBranch: string | null;
  projectFolder: string;
}

/**
 * Everything this branch would land, one file after another. Lines never
 * wrap — preserving the vertical alignment of changed lines is the point of
 * reviewing at this width, so long lines scroll instead.
 */
export default function DiffTab({
  node,
  parentBranch,
  projectFolder,
}: DiffTabProps) {
  const [remote, setRemote] = useState<Remote>({ status: "loading" });

  // node.head is a trigger: a new commit in the worktree means a new diff.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    let active = true;
    setRemote({ status: "loading" });

    worktreeDiff({
      parentBranch,
      path: projectFolder,
      worktreePath: node.id,
    })
      .then((diff) => {
        if (active) {
          setRemote({ diff, status: "ready" });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setRemote({
            error:
              error instanceof Error
                ? error.message
                : "The diff failed to load.",
            status: "error",
          });
        }
      });

    return () => {
      active = false;
    };
  }, [node.head, node.id, parentBranch, projectFolder]);

  if (remote.status === "loading") {
    return <Message text="Reading the diff…" />;
  }

  if (remote.status === "error") {
    return <Message text={remote.error} tone="error" />;
  }

  const { files, untracked } = remote.diff;
  if (files.length === 0 && untracked.length === 0) {
    return <Message text={`No changes against ${parentBranch ?? "HEAD"}.`} />;
  }

  const totalChanged = files.reduce(
    (sum, file) => sum + file.additions + file.deletions,
    0
  );
  const collapseAll =
    files.length > COLLAPSE_ALL_FILES || totalChanged > COLLAPSE_ALL_LINES;

  return (
    <div className="h-full overflow-y-auto">
      <p className="sticky top-0 z-20 border-bw-hairline border-b bg-bw-surface px-4 py-1.5 font-mono text-[11px] text-bw-muted">
        {`${parentBranch ?? "HEAD"} → working tree`}
      </p>
      {collapseAll ? (
        <p className="px-4 py-2 font-mono text-[11px] text-bw-edge">
          Files are collapsed for large diffs. Select a file to expand it.
        </p>
      ) : null}
      {files.map((file) => (
        <FileSection
          file={file}
          forceCollapsed={collapseAll}
          key={file.path}
          worktreePath={node.id}
        />
      ))}
      {untracked.length > 0 ? (
        <section className="px-4 py-3">
          <h3 className="pb-1.5 font-mono text-[10.5px] text-bw-muted uppercase tracking-wide">
            untracked — not in git yet
          </h3>
          {untracked.map((path) => (
            <p className="font-mono text-[12px] text-bw-ink" key={path}>
              {path}
            </p>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function Message({ text, tone }: { text: string; tone?: "error" }) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <p
        className={cn(
          "text-center font-mono text-[12px]",
          tone === "error" ? "text-bw-removed" : "text-bw-muted"
        )}
      >
        {text}
      </p>
    </div>
  );
}

function FileSection({
  file,
  forceCollapsed,
  worktreePath,
}: {
  file: FileDiff;
  forceCollapsed: boolean;
  worktreePath: string;
}) {
  const changed = file.additions + file.deletions;
  const [open, setOpen] = useState(
    !forceCollapsed && changed <= COLLAPSE_FILE_OVER
  );
  const Chevron = open ? ChevronDown : ChevronRight;

  const toggle = useCallback(() => {
    setOpen((current) => !current);
  }, []);

  return (
    <section className="border-bw-hairline border-b">
      <button
        className="sticky top-[29px] z-10 flex w-full items-center gap-2 border-bw-hairline bg-bw-surface px-4 py-2 text-left"
        onClick={toggle}
        type="button"
      >
        <Chevron className="shrink-0 text-bw-muted" size={12} />
        <span className="min-w-0 truncate font-mono text-[12px] text-bw-ink">
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        {file.dirty ? (
          <span className="rounded bg-bw-pending/10 px-1.5 py-px font-mono text-[10px] text-bw-pending">
            uncommitted
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[11px]">
          {file.additions > 0 ? (
            <span className="text-bw-done">+{file.additions}</span>
          ) : null}
          {file.deletions > 0 ? (
            <span className="text-bw-removed">−{file.deletions}</span>
          ) : null}
        </span>
      </button>

      {open ? <FileBody file={file} worktreePath={worktreePath} /> : null}
    </section>
  );
}

function FileBody({
  file,
  worktreePath,
}: {
  file: FileDiff;
  worktreePath: string;
}) {
  if (file.binary) {
    return (
      <p className="px-4 pb-3 font-mono text-[11px] text-bw-muted">
        binary file
      </p>
    );
  }

  if (file.hunks.length === 0) {
    return null;
  }

  return <Hunks file={file} worktreePath={worktreePath} />;
}

function Hunks({
  file,
  worktreePath,
}: {
  file: FileDiff;
  worktreePath: string;
}) {
  const lines = useMemo(
    () => file.hunks.flatMap((hunk) => hunk.lines),
    [file.hunks]
  );
  const tokens = useHighlight(file.path, lines);
  const segments = useSegments(lines);
  const fold = useFolds(file, worktreePath);

  let cursor = 0;
  return (
    <div className="overflow-x-auto pb-2">
      {file.hunks.map((hunk, hunkIndex) => {
        const start = cursor;
        cursor += hunk.lines.length;
        return (
          <div key={hunk.header}>
            <FoldRow fold={fold} hunkIndex={hunkIndex} />
            {hunk.lines.map((line, offset) => (
              <Row
                key={`${hunk.header}:${line.oldNo ?? "a"}:${line.newNo ?? "d"}`}
                line={line}
                segments={segments.get(start + offset) ?? null}
                tokens={tokens?.[start + offset] ?? null}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The stretch of untouched lines a hunk skipped: a click reads the worktree
 * file — which IS the diff's new side — and splices the real lines in.
 */
function useFolds(file: FileDiff, worktreePath: string) {
  const [context, setContext] = useState<string[] | null>(null);
  const [openGaps, setOpenGaps] = useState<ReadonlySet<number>>(new Set());
  const [unavailable, setUnavailable] = useState(false);

  const expand = useCallback(
    (hunkIndex: number) => {
      const admit = () => {
        setOpenGaps((current) => new Set(current).add(hunkIndex));
      };
      if (context) {
        admit();
        return;
      }
      readTextFile(worktreePath, file.path)
        .then((content) => {
          if (content.kind === "text") {
            setContext(content.text.split("\n"));
            admit();
          } else {
            setUnavailable(true);
          }
        })
        .catch(() => setUnavailable(true));
    },
    [context, file.path, worktreePath]
  );

  const gapBefore = (
    hunkIndex: number
  ): { gap: number; newStart: number; oldStart: number } => {
    const hunk = file.hunks[hunkIndex];
    if (hunkIndex === 0) {
      return { gap: hunk.newStart - 1, newStart: 1, oldStart: 1 };
    }
    const previous = file.hunks[hunkIndex - 1];
    return {
      gap: hunk.newStart - (previous.newStart + previous.newLines),
      newStart: previous.newStart + previous.newLines,
      oldStart: previous.oldStart + previous.oldLines,
    };
  };

  return {
    context,
    expand,
    gapBefore,
    kind: file.kind,
    openGaps,
    unavailable,
  };
}

function FoldRow({
  fold,
  hunkIndex,
}: {
  fold: ReturnType<typeof useFolds>;
  hunkIndex: number;
}) {
  const { context, expand, gapBefore, kind, openGaps, unavailable } = fold;
  const { gap, newStart, oldStart } = gapBefore(hunkIndex);

  const handleClick = useCallback(() => {
    expand(hunkIndex);
  }, [expand, hunkIndex]);

  if (gap <= 0 || kind === "deleted") {
    return null;
  }

  if (openGaps.has(hunkIndex) && context) {
    return (
      <>
        {Array.from({ length: gap }, (_, offset) => {
          const line: DiffLine = {
            kind: "context",
            newNo: newStart + offset,
            oldNo: oldStart + offset,
            text: context[newStart + offset - 1] ?? "",
          };
          return (
            <Row
              key={`fold:${hunkIndex}:${line.newNo}`}
              line={line}
              segments={null}
              tokens={null}
            />
          );
        })}
      </>
    );
  }

  return (
    <button
      className="flex w-full items-center gap-2 bg-bw-subtle/60 py-0.5 pl-[5.5rem] text-left font-mono text-[10.5px] text-bw-muted transition-colors hover:text-bw-ink disabled:hover:text-bw-muted"
      disabled={unavailable}
      onClick={handleClick}
      type="button"
    >
      {gap} unmodified line{gap === 1 ? "" : "s"}
    </button>
  );
}

/** Pairs deleted/added lines and marks the tokens that differ inside them. */
function useSegments(lines: DiffLine[]): Map<number, Segment[]> {
  return useMemo(() => {
    const map = new Map<number, Segment[]>();
    for (const [delIndex, addIndex] of pairChangedLines(lines)) {
      const result = changedSegments(
        lines[delIndex].text,
        lines[addIndex].text
      );
      if (result) {
        map.set(delIndex, result.old);
        map.set(addIndex, result.new);
      }
    }
    return map;
  }, [lines]);
}

/**
 * Colours come from the grammar of the *changed* text alone — hunks are
 * highlighted as standalone snippets, and the occasional mis-token beats
 * shipping the whole old and new file across IPC to get it right.
 */
function useHighlight(path: string, lines: DiffLine[]): CodeToken[][] | null {
  const [tokens, setTokens] = useState<CodeToken[][] | null>(null);

  useEffect(() => {
    let active = true;
    setTokens(null);

    const language = languageForFile(path);
    if (language === "text" || lines.length === 0) {
      return;
    }

    highlightCodeTokens(lines.map((line) => line.text).join("\n"), language)
      .then((result) => {
        if (active && result?.length === lines.length) {
          setTokens(result);
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [lines, path]);

  return tokens;
}

const ROW_TINT: Record<DiffLine["kind"], string> = {
  add: "bg-bw-done/8",
  context: "",
  del: "bg-bw-removed/8",
};

const MARKER: Record<DiffLine["kind"], string> = {
  add: "+",
  context: " ",
  del: "−",
};

const WORD_TINT: Record<DiffLine["kind"], string> = {
  add: "rounded-[2px] bg-bw-done/25",
  context: "",
  del: "rounded-[2px] bg-bw-removed/25",
};

function Row({
  line,
  segments,
  tokens,
}: {
  line: DiffLine;
  segments: Segment[] | null;
  tokens: CodeToken[] | null;
}) {
  return (
    <div
      className={cn(
        "flex min-w-max items-stretch font-mono text-[12px] leading-[1.45]",
        ROW_TINT[line.kind]
      )}
    >
      <span className="w-11 shrink-0 select-none pr-2 text-right text-[10.5px] text-bw-edge tabular-nums leading-[1.65]">
        {line.oldNo ?? ""}
      </span>
      <span className="w-11 shrink-0 select-none pr-2 text-right text-[10.5px] text-bw-edge tabular-nums leading-[1.65]">
        {line.newNo ?? ""}
      </span>
      <span
        className={cn(
          "w-4 shrink-0 select-none text-center",
          line.kind === "add" && "text-bw-done",
          line.kind === "del" && "text-bw-removed"
        )}
      >
        {MARKER[line.kind]}
      </span>
      <span className="whitespace-pre pr-4">
        <LineContent line={line} segments={segments} tokens={tokens} />
      </span>
    </div>
  );
}

function LineContent({
  line,
  segments,
  tokens,
}: {
  line: DiffLine;
  segments: Segment[] | null;
  tokens: CodeToken[] | null;
}) {
  if (tokens && segments) {
    return overlay(tokens, segments).map((run, index) => (
      <span
        className={cn(run.changed && WORD_TINT[line.kind])}
        data-changed={run.changed || undefined}
        // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional fragments of one static line
        key={index}
        style={{ color: run.color }}
      >
        {run.text}
      </span>
    ));
  }

  if (tokens) {
    return tokens.map((token, index) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional fragments of one static line
      <span key={index} style={{ color: token.color }}>
        {token.text}
      </span>
    ));
  }

  if (segments) {
    return segments.map((segment, index) => (
      <span
        className={cn(segment.changed && WORD_TINT[line.kind])}
        data-changed={segment.changed || undefined}
        // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional fragments of one static line
        key={index}
      >
        {segment.text}
      </span>
    ));
  }

  return line.text;
}

/** Splits syntax tokens at word-change boundaries so both colourings hold. */
function overlay(
  tokens: CodeToken[],
  segments: Segment[]
): Array<{ changed: boolean; color?: string; text: string }> {
  const runs: Array<{ changed: boolean; color?: string; text: string }> = [];
  let segmentIndex = 0;
  let segmentUsed = 0;

  for (const token of tokens) {
    let tokenUsed = 0;
    while (tokenUsed < token.text.length && segmentIndex < segments.length) {
      const segment = segments[segmentIndex];
      const take = Math.min(
        token.text.length - tokenUsed,
        segment.text.length - segmentUsed
      );
      runs.push({
        changed: segment.changed,
        color: token.color,
        text: token.text.slice(tokenUsed, tokenUsed + take),
      });
      tokenUsed += take;
      segmentUsed += take;
      if (segmentUsed >= segment.text.length) {
        segmentIndex += 1;
        segmentUsed = 0;
      }
    }
    if (tokenUsed < token.text.length) {
      runs.push({
        changed: false,
        color: token.color,
        text: token.text.slice(tokenUsed),
      });
    }
  }

  return runs;
}
