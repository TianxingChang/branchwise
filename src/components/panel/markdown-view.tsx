import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect } from "react";
import { Markdown } from "tiptap-markdown";

interface MarkdownViewProps {
  text: string;
}

/**
 * Renders markdown through tiptap.
 *
 * The editor is read-only: this is a viewer, and tiptap is here for its parser
 * and schema-accurate rendering rather than for editing. The content is set
 * again whenever the file changes on disk, so a rewrite outside the app shows
 * up without remounting the editor and losing the scroll position.
 */
export default function MarkdownView({ text }: MarkdownViewProps) {
  const editor = useEditor({
    content: text,
    editable: false,
    editorProps: {
      attributes: {
        class: "branchwise-markdown focus:outline-none",
      },
    },
    extensions: [StarterKit, Markdown.configure({ html: false })],
    immediatelyRender: false,
  });

  useEffect(() => {
    if (editor && !editor.isDestroyed) {
      editor.commands.setContent(text);
    }
  }, [editor, text]);

  return (
    <div className="px-4 py-3">
      <EditorContent editor={editor} />
    </div>
  );
}
