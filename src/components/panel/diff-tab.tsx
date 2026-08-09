import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { worktreeDiff } from "@/actions/repo";
import { languageForFile } from "@/lib/files/language";
import { highlightCodeLines } from "@/lib/files/shiki";
import type { CanvasNode } from "@/types/branch";
import type { DiffLine, FileDiff, WorktreeDiff } from "@/types/diff";
import { cn } from "@/utils/tailwind";

/** Files past this many changed lines start collapsed. */
const COLLAPSE_OVER = 400;

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

  return (
    <div className="h-full overflow-y-auto">
      {files.map((file) => (
        <FileSection file={file} key={file.path} />
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

function FileSection({ file }: { file: FileDiff }) {
  const changed = file.additions + file.deletions;
  const [open, setOpen] = useState(changed <= COLLAPSE_OVER);
  const Chevron = open ? ChevronDown : ChevronRight;

  const toggle = useCallback(() => {
    setOpen((current) => !current);
  }, []);

  return (
    <section className="border-bw-hairline border-b">
      <button
        className="sticky top-0 z-10 flex w-full items-center gap-2 border-bw-hairline bg-bw-surface px-4 py-2 text-left"
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

      {open ? <FileBody file={file} /> : null}
    </section>
  );
}

function FileBody({ file }: { file: FileDiff }) {
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

  return <Hunks file={file} />;
}

function Hunks({ file }: { file: FileDiff }) {
  const lines = useMemo(
    () => file.hunks.flatMap((hunk) => hunk.lines),
    [file.hunks]
  );
  const markup = useHighlight(file.path, lines);

  let cursor = 0;
  return (
    <div className="overflow-x-auto pb-2">
      {file.hunks.map((hunk) => {
        const start = cursor;
        cursor += hunk.lines.length;
        return (
          <div key={hunk.header}>
            <p className="px-4 py-1 font-mono text-[10.5px] text-bw-edge">
              {hunk.header}
            </p>
            {hunk.lines.map((line, offset) => (
              <Row
                key={`${hunk.header}:${line.oldNo ?? "a"}:${line.newNo ?? "d"}`}
                line={line}
                markup={markup?.[start + offset] ?? null}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Colours come from the grammar of the *changed* text alone — hunks are
 * highlighted as standalone snippets, and the occasional mis-token beats
 * shipping the whole old and new file across IPC to get it right.
 */
function useHighlight(path: string, lines: DiffLine[]): string[] | null {
  const [markup, setMarkup] = useState<string[] | null>(null);

  useEffect(() => {
    let active = true;
    setMarkup(null);

    const language = languageForFile(path);
    if (language === "text" || lines.length === 0) {
      return;
    }

    highlightCodeLines(lines.map((line) => line.text).join("\n"), language)
      .then((result) => {
        if (active && result?.length === lines.length) {
          setMarkup(result);
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [lines, path]);

  return markup;
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

function Row({ line, markup }: { line: DiffLine; markup: string | null }) {
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
      {markup ? (
        <span
          className="whitespace-pre pr-4"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: markup is built from shiki tokens with escaped content
          dangerouslySetInnerHTML={{ __html: markup }}
        />
      ) : (
        <span className="whitespace-pre pr-4">{line.text}</span>
      )}
    </div>
  );
}
