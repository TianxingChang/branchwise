import { FileTree, useFileTree } from "@pierre/trees/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readTextFile, readWorktreeTree, watchFiles } from "@/actions/files";
import CodeView from "@/components/panel/code-view";
import MarkdownView from "@/components/panel/markdown-view";
import { formatBytes } from "@/lib/files/entries";
import { isMarkdown } from "@/lib/files/language";
import { isDirectoryTreePath } from "@/lib/files/scan-policy";
import type { CanvasNode } from "@/types/branch";
import type { FileContent } from "@/types/files";

const MIN_TREE_HEIGHT = 96;
const MIN_VIEWER_HEIGHT = 120;
const DEFAULT_TREE_HEIGHT = 220;

/** Matches the panel's own surface so the shadow-rooted tree does not clash. */
const TREE_CSS = `
  :host { font-size: 12px; }
  button[data-type='item'] { font-size: 12px; }
`;

interface FileTabProps {
  node: CanvasNode;
}

export default function FileTab({ node }: FileTabProps) {
  if (node.prunable) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center">
        <p className="text-[12.5px] text-bw-muted leading-relaxed">
          This worktree's directory is missing, so there are no files to browse.
          Prune it from the canvas.
        </p>
      </div>
    );
  }

  return <FileBrowser worktreePath={node.id} />;
}

function FileBrowser({ worktreePath }: { worktreePath: string }) {
  const [paths, setPaths] = useState<string[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [treeHeight, setTreeHeight] = useState(DEFAULT_TREE_HEIGHT);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setPaths(null);
    setOpenPath(null);
    setError(null);

    readWorktreeTree(worktreePath)
      .then((result) => {
        if (active) {
          setPaths(result.paths);
          setTruncated(result.truncated);
        }
      })
      .catch((loadError) => {
        if (active) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "This worktree could not be read."
          );
        }
      });

    return () => {
      active = false;
    };
  }, [worktreePath]);

  const handleSelectionChange = useCallback((selected: readonly string[]) => {
    const [first] = selected;
    if (first && !isDirectoryTreePath(first)) {
      setOpenPath(first);
    }
  }, []);

  return (
    <div className="flex h-full flex-col">
      <TreePane
        error={error}
        height={treeHeight}
        onSelect={handleSelectionChange}
        paths={paths}
        truncated={truncated}
        worktreePath={worktreePath}
      />

      <ResizeHandle height={treeHeight} onResize={setTreeHeight} />

      <div className="min-h-0 flex-1 overflow-auto">
        {openPath === null ? (
          <EmptyViewer />
        ) : (
          <OpenFile
            key={openPath}
            relativePath={openPath}
            worktreePath={worktreePath}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Applies what the watcher reports to the tree model.
 *
 * One path at a time rather than a rebuild: `resetPaths` would discard the
 * expansion and selection every time a file is saved.
 */
async function followDisk(options: {
  known: Set<string>;
  model: { add: (path: string) => void; remove: (path: string) => void };
  signal: AbortSignal;
  worktreePath: string;
}): Promise<void> {
  try {
    const stream = await watchFiles(options.worktreePath, options.signal);

    for await (const change of stream) {
      if (options.signal.aborted) {
        return;
      }
      if (change.kind === "removed") {
        if (options.known.delete(change.path)) {
          options.model.remove(change.path);
        }
      } else if (!options.known.has(change.path)) {
        options.known.add(change.path);
        options.model.add(change.path);
      }
    }
  } catch {
    // The tree keeps working; it just stops following the disk.
  }
}

/**
 * Hosts the tree model and keeps it level with the disk.
 *
 * The model is path-first, so a change is applied as `add`/`remove` on the one
 * path that moved rather than by rebuilding the whole tree — rebuilding would
 * throw away expansion and selection every time a file is saved.
 */
function TreePane({
  error,
  height,
  onSelect,
  paths,
  truncated,
  worktreePath,
}: {
  error: string | null;
  height: number;
  onSelect: (selected: readonly string[]) => void;
  paths: string[] | null;
  truncated: boolean;
  worktreePath: string;
}) {
  const initialPaths = useMemo(() => paths ?? [], [paths]);
  const { model } = useFileTree({
    initialExpansion: 1,
    onSelectionChange: onSelect,
    paths: initialPaths,
    search: true,
    unsafeCSS: TREE_CSS,
  });

  const known = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!paths) {
      return;
    }
    known.current = new Set(paths);
    model.resetPaths(paths);
  }, [model, paths]);

  useEffect(() => {
    if (!paths) {
      return;
    }

    const controller = new AbortController();
    followDisk({
      known: known.current,
      model,
      signal: controller.signal,
      worktreePath,
    });

    return () => controller.abort();
  }, [model, paths, worktreePath]);

  if (error) {
    return (
      <p className="px-4 py-3 text-[12px] text-bw-pending" style={{ height }}>
        {error}
      </p>
    );
  }

  if (!paths) {
    return (
      <p className="px-4 py-3 text-[12px] text-bw-muted" style={{ height }}>
        Reading the worktree…
      </p>
    );
  }

  return (
    <div className="flex shrink-0 flex-col" style={{ height }}>
      <FileTree model={model} style={{ flex: 1, minHeight: 0 }} />
      {truncated ? (
        <p className="px-3 pb-1 text-[10.5px] text-bw-pending">
          Large worktree — the listing stops early.
        </p>
      ) : null}
    </div>
  );
}

function ResizeHandle({
  height,
  onResize,
}: {
  height: number;
  onResize: (next: number) => void;
}) {
  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const originY = event.clientY;
      const originHeight = height;

      const move = (moveEvent: PointerEvent) => {
        const container = (event.target as HTMLElement).parentElement;
        const available = container?.clientHeight ?? Number.POSITIVE_INFINITY;
        const next = Math.min(
          Math.max(MIN_TREE_HEIGHT, originHeight + moveEvent.clientY - originY),
          Math.max(MIN_TREE_HEIGHT, available - MIN_VIEWER_HEIGHT)
        );
        onResize(next);
      };

      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [height, onResize]
  );

  return (
    <div
      className="h-1.5 shrink-0 cursor-row-resize border-bw-hairline border-y bg-bw-canvas/40 transition-colors hover:bg-bw-subtle"
      onPointerDown={handlePointerDown}
    />
  );
}

function EmptyViewer() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 px-8 text-center">
      <p className="text-[13px] text-bw-ink">Open a file</p>
      <p className="text-[12.5px] text-bw-muted">
        Pick one from the tree above.
      </p>
    </div>
  );
}

/**
 * Reads one file and keeps it current.
 *
 * The same watcher that drives the tree also tells this view when the open file
 * is rewritten, so an agent editing on this branch shows up without a reload.
 */
function OpenFile({
  relativePath,
  worktreePath,
}: {
  relativePath: string;
  worktreePath: string;
}) {
  const [content, setContent] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await readTextFile(worktreePath, relativePath);
      setContent(result);
      setError(null);
    } catch (readError) {
      setError(
        readError instanceof Error
          ? readError.message
          : "That file could not be read."
      );
    }
  }, [relativePath, worktreePath]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      try {
        const stream = await watchFiles(worktreePath, controller.signal);
        for await (const change of stream) {
          if (controller.signal.aborted) {
            break;
          }
          if (change.kind === "changed" && change.path === relativePath) {
            load();
          }
        }
      } catch {
        // Stops following the file; the contents already shown stay valid.
      }
    })();

    return () => controller.abort();
  }, [load, relativePath, worktreePath]);

  const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-bw-hairline border-b px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-bw-ink">
          {relativePath}
        </span>
        {content?.kind === "text" ? (
          <span className="shrink-0 text-[10.5px] text-bw-edge">
            {content.lineCount} lines · {formatBytes(content.size)}
          </span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <FileBody
          content={content}
          error={error}
          fileName={name}
          relativePath={relativePath}
        />
      </div>
    </div>
  );
}

function FileBody({
  content,
  error,
  fileName,
  relativePath,
}: {
  content: FileContent | null;
  error: string | null;
  fileName: string;
  relativePath: string;
}) {
  if (error) {
    return <p className="px-4 py-3 text-[12px] text-bw-pending">{error}</p>;
  }

  if (!content) {
    return <p className="px-4 py-3 text-[12px] text-bw-muted">Reading…</p>;
  }

  if (content.kind === "binary") {
    return (
      <p className="px-4 py-3 text-[12px] text-bw-muted">
        Binary file, {formatBytes(content.size)}.
      </p>
    );
  }

  if (content.kind === "too-large") {
    return (
      <p className="px-4 py-3 text-[12px] text-bw-muted">
        {formatBytes(content.size)} is too large to show here. Open it from the
        Terminal tab instead.
      </p>
    );
  }

  if (isMarkdown(relativePath)) {
    return <MarkdownView text={content.text} />;
  }

  return <CodeView fileName={fileName} text={content.text} />;
}
