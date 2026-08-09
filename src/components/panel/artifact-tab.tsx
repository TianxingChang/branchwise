import { FileText, Pencil, Plus, Shapes, Trash2 } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  createArtifact,
  deleteArtifact,
  listArtifacts,
  renameArtifact,
} from "@/actions/artifacts";
import ArtifactNote from "@/components/panel/artifact-note";
import { sanitizeArtifactName } from "@/lib/artifacts/naming";
import type { SaveQueue } from "@/lib/artifacts/save-queue";
import type { ArtifactKind, ArtifactMeta } from "@/types/artifacts";
import { cn } from "@/utils/tailwind";

// tldraw is by far the heaviest thing the renderer can load, and most
// sessions never open a canvas — so it stays out of the startup bundle.
const ArtifactCanvas = lazy(() => import("@/components/panel/artifact-canvas"));

const MIN_LIST_WIDTH = 150;
const MIN_EDITOR_WIDTH = 200;
const DEFAULT_LIST_WIDTH = 170;

const KIND_ICONS: Record<ArtifactKind, typeof FileText> = {
  canvas: Shapes,
  note: FileText,
};

interface OpenArtifact {
  kind: ArtifactKind;
  name: string;
}

function isSame(meta: ArtifactMeta, other: OpenArtifact | null): boolean {
  return other !== null && meta.kind === other.kind && meta.name === other.name;
}

/** The handler lists in this order; local inserts have to agree with it. */
function sortMetas(metas: ArtifactMeta[]): ArtifactMeta[] {
  return [...metas].sort(
    (left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
      left.kind.localeCompare(right.kind)
  );
}

interface ArtifactTabProps {
  projectFolder: string;
}

/**
 * The project's shelf: notes and canvases that belong to the work, not to any
 * one branch. Files under .branchwise/artifacts — the File tab shows what the
 * repository says, this tab holds what you say about it.
 */
export default function ArtifactTab({ projectFolder }: ArtifactTabProps) {
  const [metas, setMetas] = useState<ArtifactMeta[] | null>(null);
  const [open, setOpen] = useState<OpenArtifact | null>(null);
  const [listWidth, setListWidth] = useState(DEFAULT_LIST_WIDTH);
  const splitRef = useRef<HTMLDivElement>(null);

  /** The open editor's save queue. Rename must flush it first (a pending
   * save would recreate the old file), delete must discard it (a pending
   * save would resurrect the deleted one). */
  const openQueue = useRef<SaveQueue | null>(null);

  const handleQueue = useCallback((queue: SaveQueue | null) => {
    openQueue.current = queue;
  }, []);

  // The panel itself is resizable, so the split has to give way when it
  // narrows — same bargain the file tab strikes.
  useEffect(() => {
    const element = splitRef.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver(() => {
      const largest = Math.max(
        MIN_LIST_WIDTH,
        element.clientWidth - MIN_EDITOR_WIDTH
      );
      setListWidth((current) => Math.min(current, largest));
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    setMetas(null);
    setOpen(null);

    listArtifacts(projectFolder)
      .then((result) => {
        if (active) {
          setMetas(result);
        }
      })
      .catch(() => {
        if (active) {
          setMetas([]);
        }
      });

    return () => {
      active = false;
    };
  }, [projectFolder]);

  const handleCreate = useCallback(
    async (kind: ArtifactKind) => {
      const meta = await createArtifact(projectFolder, kind);
      if (!meta) {
        return;
      }
      setMetas((current) => sortMetas([...(current ?? []), meta]));
      setOpen({ kind: meta.kind, name: meta.name });
    },
    [projectFolder]
  );

  const handleOpen = useCallback((meta: ArtifactMeta) => {
    setOpen((current) =>
      isSame(meta, current) ? current : { kind: meta.kind, name: meta.name }
    );
  }, []);

  const handleRename = useCallback(
    async (meta: ArtifactMeta, requested: string) => {
      const clean = sanitizeArtifactName(requested);
      if (clean === null || clean === meta.name) {
        return;
      }

      const wasOpen = isSame(meta, open);
      if (wasOpen) {
        try {
          await openQueue.current?.flush();
        } catch {
          // The last edit could not be written; renaming now would strand
          // it under the old name. Keep the name until saving works.
          return;
        }
      }

      const next = await renameArtifact(
        projectFolder,
        meta.kind,
        meta.name,
        clean
      );

      if (next === null) {
        // The file is gone — someone deleted it under us. Drop the row.
        setMetas(
          (current) =>
            current?.filter((candidate) => candidate !== meta) ?? current
        );
        if (wasOpen) {
          setOpen(null);
        }
        return;
      }

      setMetas((current) =>
        sortMetas(
          (current ?? []).map((candidate) =>
            candidate === meta ? next : candidate
          )
        )
      );
      if (wasOpen) {
        setOpen({ kind: next.kind, name: next.name });
      }
    },
    [open, projectFolder]
  );

  const handleDelete = useCallback(
    async (meta: ArtifactMeta) => {
      const wasOpen = isSame(meta, open);
      if (wasOpen) {
        openQueue.current?.discard();
      }

      const gone = await deleteArtifact(projectFolder, meta.kind, meta.name);
      if (!gone) {
        return;
      }

      setMetas(
        (current) =>
          current?.filter((candidate) => candidate !== meta) ?? current
      );
      if (wasOpen) {
        setOpen(null);
      }
    },
    [open, projectFolder]
  );

  return (
    <div className="flex h-full" ref={splitRef}>
      <div
        className="flex min-w-0 shrink-0 flex-col overflow-hidden"
        style={{ width: listWidth }}
      >
        <div className="flex items-center gap-1 px-2 pt-2 pb-1.5">
          <CreateButton kind="note" label="Note" onCreate={handleCreate} />
          <CreateButton kind="canvas" label="Canvas" onCreate={handleCreate} />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          <ShelfList
            metas={metas}
            onDelete={handleDelete}
            onOpen={handleOpen}
            onRename={handleRename}
            open={open}
          />
        </div>
      </div>

      <ResizeHandle onResize={setListWidth} width={listWidth} />

      <div className="min-w-0 flex-1 overflow-hidden">
        <EditorPane
          onQueue={handleQueue}
          open={open}
          projectFolder={projectFolder}
        />
      </div>
    </div>
  );
}

function EditorPane({
  onQueue,
  open,
  projectFolder,
}: {
  onQueue: (queue: SaveQueue | null) => void;
  open: OpenArtifact | null;
  projectFolder: string;
}) {
  if (open === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 px-8 text-center">
        <p className="text-[13px] text-bw-ink">Open an artifact</p>
        <p className="text-[12.5px] text-bw-muted">
          Pick one from the list, or create it.
        </p>
      </div>
    );
  }

  // Keyed by identity so switching artifacts flushes the old editor on its
  // way out and reads the new file on its way in.
  if (open.kind === "note") {
    return (
      <ArtifactNote
        key={`note:${open.name}`}
        name={open.name}
        onQueue={onQueue}
        projectFolder={projectFolder}
      />
    );
  }

  return (
    <Suspense
      fallback={<p className="px-4 py-3 text-[12px] text-bw-muted">Reading…</p>}
    >
      <ArtifactCanvas
        key={`canvas:${open.name}`}
        name={open.name}
        onQueue={onQueue}
        projectFolder={projectFolder}
      />
    </Suspense>
  );
}

function ShelfList({
  metas,
  onDelete,
  onOpen,
  onRename,
  open,
}: {
  metas: ArtifactMeta[] | null;
  onDelete: (meta: ArtifactMeta) => void;
  onOpen: (meta: ArtifactMeta) => void;
  onRename: (meta: ArtifactMeta, requested: string) => void;
  open: OpenArtifact | null;
}) {
  if (metas === null) {
    return <p className="px-2 py-1 text-[12px] text-bw-muted">Reading…</p>;
  }

  if (metas.length === 0) {
    return (
      <p className="px-2 py-1 text-[12px] text-bw-muted leading-relaxed">
        Nothing here yet. What you create lives with the project, not any one
        branch.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {metas.map((meta) => (
        <ArtifactRow
          isActive={isSame(meta, open)}
          key={`${meta.kind}:${meta.name}`}
          meta={meta}
          onDelete={onDelete}
          onOpen={onOpen}
          onRename={onRename}
        />
      ))}
    </ul>
  );
}

function CreateButton({
  kind,
  label,
  onCreate,
}: {
  kind: ArtifactKind;
  label: string;
  onCreate: (kind: ArtifactKind) => void;
}) {
  const Icon = KIND_ICONS[kind];
  const handleClick = useCallback(() => onCreate(kind), [kind, onCreate]);

  return (
    <button
      className="flex items-center gap-1 rounded-md border border-bw-hairline px-1.5 py-1 text-[11px] text-bw-muted transition-colors hover:bg-bw-subtle hover:text-bw-ink"
      onClick={handleClick}
      type="button"
    >
      <Plus size={10} />
      <Icon size={11} />
      {label}
    </button>
  );
}

function ArtifactRow({
  isActive,
  meta,
  onDelete,
  onOpen,
  onRename,
}: {
  isActive: boolean;
  meta: ArtifactMeta;
  onDelete: (meta: ArtifactMeta) => void;
  onOpen: (meta: ArtifactMeta) => void;
  onRename: (meta: ArtifactMeta, requested: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const Icon = KIND_ICONS[meta.kind];

  const handleOpen = useCallback(() => onOpen(meta), [meta, onOpen]);
  const handleRenameStart = useCallback(() => setDraft(meta.name), [meta.name]);
  const handleDraftChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setDraft(event.target.value),
    []
  );
  const handleDraftCancel = useCallback(() => setDraft(null), []);
  const handleDraftKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        onRename(meta, event.currentTarget.value);
        setDraft(null);
      }
      if (event.key === "Escape") {
        setDraft(null);
      }
    },
    [meta, onRename]
  );
  const handleDisarm = useCallback(() => setArmed(false), []);
  const handleDelete = useCallback(() => {
    if (armed) {
      setArmed(false);
      onDelete(meta);
    } else {
      setArmed(true);
    }
  }, [armed, meta, onDelete]);

  if (draft !== null) {
    return (
      <li>
        <input
          autoFocus
          className="w-full rounded-md border border-bw-edge bg-bw-surface px-2 py-1 text-[12px] text-bw-ink outline-none"
          onBlur={handleDraftCancel}
          onChange={handleDraftChange}
          onKeyDown={handleDraftKeyDown}
          value={draft}
        />
      </li>
    );
  }

  return (
    <li
      className={cn(
        "group flex items-center gap-1 rounded-lg pr-1.5",
        isActive ? "bg-bw-subtle" : "hover:bg-bw-subtle/60"
      )}
    >
      <button
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-2 text-left"
        onClick={handleOpen}
        type="button"
      >
        <Icon className="shrink-0 text-bw-muted" size={12} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[12px]",
            isActive ? "text-bw-ink" : "text-bw-muted group-hover:text-bw-ink"
          )}
        >
          {meta.name}
        </span>
      </button>

      <button
        aria-label={`Rename ${meta.name}`}
        className="hidden size-5 shrink-0 items-center justify-center rounded text-bw-muted hover:text-bw-ink group-hover:flex"
        onClick={handleRenameStart}
        title="Rename"
        type="button"
      >
        <Pencil size={11} />
      </button>

      <button
        aria-label={
          armed ? `Really delete ${meta.name}` : `Delete ${meta.name}`
        }
        className={cn(
          "size-5 shrink-0 items-center justify-center rounded",
          armed
            ? "flex text-bw-pending"
            : "hidden text-bw-muted hover:text-bw-ink group-hover:flex"
        )}
        onClick={handleDelete}
        onMouseLeave={handleDisarm}
        title={armed ? "Click again to delete" : "Delete"}
        type="button"
      >
        <Trash2 size={11} />
      </button>
    </li>
  );
}

/** Splits the list from the editor — the same handle the file tab uses. */
function ResizeHandle({
  onResize,
  width,
}: {
  onResize: (next: number) => void;
  width: number;
}) {
  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const originX = event.clientX;
      const originWidth = width;
      const container = event.currentTarget.parentElement;

      const move = (moveEvent: PointerEvent) => {
        const available = container?.clientWidth ?? Number.POSITIVE_INFINITY;
        const next = Math.min(
          Math.max(MIN_LIST_WIDTH, originWidth + moveEvent.clientX - originX),
          Math.max(MIN_LIST_WIDTH, available - MIN_EDITOR_WIDTH)
        );
        onResize(next);
      };

      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [onResize, width]
  );

  return (
    <div
      className="relative z-10 w-px shrink-0 cursor-col-resize bg-bw-hairline after:absolute after:inset-y-0 after:-left-1 after:w-2 after:content-['']"
      onPointerDown={handlePointerDown}
    />
  );
}
