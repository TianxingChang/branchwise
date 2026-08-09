import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type Editor,
  getSnapshot,
  type TLEditorSnapshot,
  Tldraw,
} from "tldraw";
import { readArtifact, writeArtifact } from "@/actions/artifacts";
import { createSaveQueue, type SaveQueue } from "@/lib/artifacts/save-queue";
import "tldraw/tldraw.css";

/** Bundled fonts and icons — the default would fetch them from tldraw's CDN,
 * and a desktop app should not need the network to draw a rectangle. */
const ASSET_URLS = getAssetUrlsByImport();

interface ArtifactCanvasProps {
  name: string;
  /** Hands the shelf this editor's save queue, and takes it back on unmount —
   * the shelf must flush before a rename and discard before a delete. */
  onQueue: (queue: SaveQueue | null) => void;
  projectFolder: string;
}

/**
 * Edits one canvas — a tldraw editor over a .tldr file.
 *
 * The snapshot loads once on mount and last writer wins after that, the same
 * bargain the note makes. Only document changes from this user schedule a
 * save: camera moves are session state and would otherwise churn the file's
 * mtime with nothing to show for it.
 */
export default function ArtifactCanvas({
  name,
  onQueue,
  projectFolder,
}: ArtifactCanvasProps) {
  const [initial, setInitial] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setInitial(null);

    readArtifact(projectFolder, "canvas", name)
      // A missing file is a blank canvas; the first edit creates it.
      .then((result) => {
        if (active) {
          setInitial(result?.content ?? "");
        }
      })
      .catch(() => {
        if (active) {
          setInitial("");
        }
      });

    return () => {
      active = false;
    };
  }, [name, projectFolder]);

  if (initial === null) {
    return <p className="px-4 py-3 text-[12px] text-bw-muted">Reading…</p>;
  }

  return (
    <LoadedCanvas
      initial={initial}
      name={name}
      onQueue={onQueue}
      projectFolder={projectFolder}
    />
  );
}

function LoadedCanvas({
  initial,
  name,
  onQueue,
  projectFolder,
}: {
  initial: string;
  name: string;
  onQueue: (queue: SaveQueue | null) => void;
  projectFolder: string;
}) {
  const parsed = useMemo((): TLEditorSnapshot | "empty" | "unreadable" => {
    if (initial.trim().length === 0) {
      return "empty";
    }
    try {
      return JSON.parse(initial) as TLEditorSnapshot;
    } catch {
      return "unreadable";
    }
  }, [initial]);

  const handleMount = useCallback(
    (editor: Editor) => {
      if (parsed !== "empty" && parsed !== "unreadable") {
        try {
          editor.loadSnapshot(parsed);
        } catch (error) {
          // A parseable file that is not a snapshot. Start blank; the file
          // is only overwritten if the user actually draws something.
          console.warn("Could not load canvas snapshot", error);
        }
      }

      const queue = createSaveQueue(async () => {
        const snapshot = JSON.stringify(getSnapshot(editor.store));
        const saved = await writeArtifact(
          projectFolder,
          "canvas",
          name,
          snapshot
        );
        if (!saved) {
          // Leaves the queue dirty, so the change is retried instead of lost.
          throw new Error(`Could not save the canvas "${name}".`);
        }
      });

      onQueue(queue);
      const unlisten = editor.store.listen(() => queue.schedule(), {
        scope: "document",
        source: "user",
      });

      return () => {
        unlisten();
        onQueue(null);
        queue.dispose();
      };
    },
    [name, onQueue, parsed, projectFolder]
  );

  if (parsed === "unreadable") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 px-8 text-center">
        <p className="text-[13px] text-bw-ink">This canvas cannot be read</p>
        <p className="text-[12.5px] text-bw-muted leading-relaxed">
          The file behind it is not a tldraw document any more. Fix it on disk,
          or delete the canvas from the list.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full">
      <Tldraw assetUrls={ASSET_URLS} onMount={handleMount} />
    </div>
  );
}
