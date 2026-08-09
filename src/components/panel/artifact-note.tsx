import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";
import { Markdown } from "tiptap-markdown";
import { readArtifact, writeArtifact } from "@/actions/artifacts";
import { createSaveQueue, type SaveQueue } from "@/lib/artifacts/save-queue";

interface ArtifactNoteProps {
  name: string;
  /** Hands the shelf this editor's save queue, and takes it back on unmount —
   * the shelf must flush before a rename and discard before a delete. */
  onQueue: (queue: SaveQueue | null) => void;
  projectFolder: string;
}

/**
 * Edits one note, autosaving as markdown.
 *
 * The note is read once and then the editor owns the text: unlike the file
 * tab's viewer there is no watcher re-applying the disk, because merging an
 * external rewrite into a live editing session silently is how half-typed
 * sentences get eaten. Last writer wins, per artifact.
 */
export default function ArtifactNote({
  name,
  onQueue,
  projectFolder,
}: ArtifactNoteProps) {
  const [initial, setInitial] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setInitial(null);

    readArtifact(projectFolder, "note", name)
      // A missing file is an empty note; the first save creates it.
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
    <LoadedNote
      initial={initial}
      name={name}
      onQueue={onQueue}
      projectFolder={projectFolder}
    />
  );
}

/** Reads the markdown back out of the editor tiptap-markdown maintains. */
function markdownOf(editor: {
  getText: () => string;
  storage: unknown;
}): string {
  const storage = editor.storage as {
    markdown?: { getMarkdown?: () => string };
  };
  return storage.markdown?.getMarkdown?.() ?? editor.getText();
}

function LoadedNote({
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
  const queueRef = useRef<SaveQueue | null>(null);

  const editor = useEditor({
    content: initial,
    editorProps: {
      attributes: {
        class: "branchwise-markdown min-h-full focus:outline-none",
      },
    },
    extensions: [StarterKit, Markdown.configure({ html: false })],
    immediatelyRender: false,
    onUpdate: () => queueRef.current?.schedule(),
  });

  useEffect(() => {
    if (!editor) {
      return;
    }

    const queue = createSaveQueue(async () => {
      const saved = await writeArtifact(
        projectFolder,
        "note",
        name,
        markdownOf(editor)
      );
      if (!saved) {
        // Leaves the queue dirty, so the change is retried instead of lost.
        throw new Error(`Could not save the note "${name}".`);
      }
    });

    queueRef.current = queue;
    onQueue(queue);

    return () => {
      onQueue(null);
      queueRef.current = null;
      queue.dispose();
    };
  }, [editor, name, onQueue, projectFolder]);

  return (
    <div className="h-full overflow-auto px-4 py-3">
      <EditorContent className="h-full" editor={editor} />
    </div>
  );
}
