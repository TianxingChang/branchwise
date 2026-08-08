import { ChevronDown, ChevronRight, Folder, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { listDirectory, readTextFile } from "@/actions/files";
import { iconForFile } from "@/components/panel/file-icon";
import { formatBytes, matchesFilter } from "@/lib/files/entries";
import type { CanvasNode } from "@/types/branch";
import type { FileContent, FileEntry } from "@/types/files";
import { cn } from "@/utils/tailwind";

const ROW_INDENT = 12;

interface FileTabProps {
  node: CanvasNode;
}

export default function FileTab({ node }: FileTabProps) {
  const [openPath, setOpenPath] = useState<string | null>(null);

  const closeFile = useCallback(() => setOpenPath(null), []);

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

  if (openPath !== null) {
    return (
      <FileViewer
        onBack={closeFile}
        relativePath={openPath}
        worktreePath={node.id}
      />
    );
  }

  return <FileTree onOpen={setOpenPath} worktreePath={node.id} />;
}

function FileTree({
  onOpen,
  worktreePath,
}: {
  onOpen: (relativePath: string) => void;
  worktreePath: string;
}) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [listings, setListings] = useState<Record<string, FileEntry[]>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (directory: string) => {
      try {
        const listing = await listDirectory(worktreePath, directory);
        setListings((current) => ({
          ...current,
          [directory]: listing.entries,
        }));
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "That folder could not be read."
        );
      }
    },
    [worktreePath]
  );

  useEffect(() => {
    setExpanded(new Set());
    setListings({});
    setError(null);
    load("");
  }, [load]);

  const toggle = useCallback(
    (directory: string) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(directory)) {
          next.delete(directory);
        } else {
          next.add(directory);
          if (!listings[directory]) {
            load(directory);
          }
        }
        return next;
      });
    },
    [listings, load]
  );

  const handleFilter = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setFilter(event.target.value);
    },
    []
  );

  const clearFilter = useCallback(() => setFilter(""), []);

  // Flattened so the tree renders as one list: a nested render would need a
  // recursive component for what is really just rows at different depths.
  const rows = useMemo(
    () => flatten({ depth: 0, directory: "", expanded, filter, listings }),
    [expanded, filter, listings]
  );

  const root = listings[""];

  return (
    <div className="flex h-full flex-col">
      <div className="p-3 pb-2">
        <div className="flex items-center gap-2 rounded-lg border border-bw-hairline bg-bw-canvas/60 px-2.5 py-1.5 focus-within:border-bw-edge">
          <Search className="shrink-0 text-bw-muted" size={12} />
          <input
            className="min-w-0 flex-1 bg-transparent text-[12px] text-bw-ink outline-none placeholder:text-bw-muted"
            onChange={handleFilter}
            placeholder="Filter files…"
            value={filter}
          />
          {filter.length > 0 ? (
            <button
              aria-label="Clear filter"
              className="shrink-0 text-bw-muted hover:text-bw-ink"
              onClick={clearFilter}
              type="button"
            >
              <X size={11} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {error ? (
          <p className="px-4 py-3 text-[12px] text-bw-pending">{error}</p>
        ) : null}

        {root && rows.length === 0 ? (
          <p className="px-4 py-3 text-[12px] text-bw-muted">
            {filter.length > 0
              ? `Nothing matches “${filter}”.`
              : "This worktree is empty."}
          </p>
        ) : null}

        {rows.map((row) => (
          <FileRow
            depth={row.depth}
            entry={row.entry}
            isExpanded={expanded.has(row.entry.path)}
            key={row.entry.path}
            onOpen={onOpen}
            onToggle={toggle}
          />
        ))}
      </div>
    </div>
  );
}

interface Row {
  depth: number;
  entry: FileEntry;
}

/**
 * Walks the loaded listings into ordered rows.
 *
 * A filter hides non-matching *files* but keeps folders, so an expanded branch
 * does not collapse out from under the person typing.
 */
function flatten(options: {
  depth: number;
  directory: string;
  expanded: Set<string>;
  filter: string;
  listings: Record<string, FileEntry[]>;
}): Row[] {
  const entries = options.listings[options.directory];
  if (!entries) {
    return [];
  }

  const rows: Row[] = [];

  for (const entry of entries) {
    const keep =
      entry.kind === "directory" || matchesFilter(entry, options.filter);
    if (!keep) {
      continue;
    }

    rows.push({ depth: options.depth, entry });

    if (entry.kind === "directory" && options.expanded.has(entry.path)) {
      rows.push(
        ...flatten({
          depth: options.depth + 1,
          directory: entry.path,
          expanded: options.expanded,
          filter: options.filter,
          listings: options.listings,
        })
      );
    }
  }

  return rows;
}

function FileRow({
  depth,
  entry,
  isExpanded,
  onOpen,
  onToggle,
}: {
  depth: number;
  entry: FileEntry;
  isExpanded: boolean;
  onOpen: (relativePath: string) => void;
  onToggle: (directory: string) => void;
}) {
  const handleClick = useCallback(() => {
    if (entry.kind === "directory") {
      onToggle(entry.path);
    } else {
      onOpen(entry.path);
    }
  }, [entry.kind, entry.path, onOpen, onToggle]);

  const Icon = entry.kind === "directory" ? Folder : iconForFile(entry.name);
  const Chevron = isExpanded ? ChevronDown : ChevronRight;

  return (
    <button
      className="flex w-full items-center gap-1.5 py-1 pr-3 text-left transition-colors hover:bg-bw-subtle"
      onClick={handleClick}
      style={{ paddingLeft: 12 + depth * ROW_INDENT }}
      type="button"
    >
      {entry.kind === "directory" ? (
        <Chevron className="shrink-0 text-bw-muted" size={12} />
      ) : (
        <span aria-hidden className="w-3 shrink-0" />
      )}
      <Icon className="shrink-0 text-bw-muted" size={13} strokeWidth={1.75} />
      <span
        className={cn(
          "truncate text-[12px]",
          entry.kind === "directory" ? "text-bw-ink" : "text-bw-muted"
        )}
      >
        {entry.name}
      </span>
    </button>
  );
}

function FileViewer({
  onBack,
  relativePath,
  worktreePath,
}: {
  onBack: () => void;
  relativePath: string;
  worktreePath: string;
}) {
  const [content, setContent] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setContent(null);
    setError(null);

    readTextFile(worktreePath, relativePath)
      .then((result) => {
        if (active) {
          setContent(result);
        }
      })
      .catch((readError) => {
        if (active) {
          setError(
            readError instanceof Error
              ? readError.message
              : "That file could not be read."
          );
        }
      });

    return () => {
      active = false;
    };
  }, [relativePath, worktreePath]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-bw-hairline border-b px-3 py-2">
        <button
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[12px] text-bw-muted transition-colors hover:bg-bw-subtle hover:text-bw-ink"
          onClick={onBack}
          type="button"
        >
          ← Files
        </button>
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
        <FileBody content={content} error={error} />
      </div>
    </div>
  );
}

function FileBody({
  content,
  error,
}: {
  content: FileContent | null;
  error: string | null;
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

  return (
    <pre className="min-w-full px-4 py-3 font-mono text-[11.5px] text-bw-ink leading-relaxed">
      {content.text}
    </pre>
  );
}
