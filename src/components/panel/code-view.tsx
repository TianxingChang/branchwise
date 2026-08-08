import { useEffect, useState } from "react";
import { languageForFile, PLAIN_TEXT } from "@/lib/files/language";
import { highlightCode } from "@/lib/files/shiki";

interface CodeViewProps {
  fileName: string;
  text: string;
}

/**
 * Syntax-highlighted read-only view.
 *
 * Shiki is loaded lazily and grammars are fetched per language, so opening a
 * plain text file costs nothing and the first TypeScript file pays for
 * TypeScript only. Until the highlighter answers, the same text renders
 * unstyled — the layout does not move when the colour arrives.
 */
export default function CodeView({ fileName, text }: CodeViewProps) {
  const [html, setHtml] = useState<string | null>(null);
  const language = languageForFile(fileName);

  useEffect(() => {
    let active = true;
    setHtml(null);

    if (language === PLAIN_TEXT) {
      return;
    }

    highlightCode(text, language)
      .then((result) => {
        if (active) {
          setHtml(result);
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [language, text]);

  if (html) {
    return (
      <div
        className="branchwise-code px-4 py-3 font-mono text-[11.5px] leading-relaxed"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki emits its own escaped markup from the file's text
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <pre className="min-w-full px-4 py-3 font-mono text-[11.5px] text-bw-ink leading-relaxed">
      {text}
    </pre>
  );
}
