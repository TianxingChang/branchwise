import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { highlightCode } from "@/lib/files/shiki";

/** How long the copy button stays ticked before returning to its icon. */
const COPIED_FOR_MS = 1400;

interface CodeBlockProps {
  language: string | null;
  text: string;
}

/**
 * A fenced block from an agent's answer.
 *
 * The plain text renders first and the highlighted markup replaces it once
 * shiki has the grammar — a language's grammar is fetched on first use, and an
 * answer that arrives mid-stream should not wait on it to be readable.
 */
export default function CodeBlock({ language, text }: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!language) {
      return;
    }

    let live = true;
    highlightCode(text, language)
      .then((markup) => {
        if (live) {
          setHtml(markup);
        }
      })
      .catch(() => undefined);

    return () => {
      live = false;
    };
  }, [language, text]);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), COPIED_FOR_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = useCallback(() => {
    navigator.clipboard
      .writeText(text)
      .then(() => setCopied(true))
      .catch(() => undefined);
  }, [text]);

  return (
    <div className="group relative overflow-hidden rounded-card border border-bw-hairline bg-bw-canvas/70">
      <div className="flex items-center justify-between border-bw-hairline border-b px-2.5 py-1">
        <span className="font-mono text-[11px] text-bw-muted">
          {language ?? "text"}
        </span>
        <button
          aria-label="Copy code"
          className="flex size-6 items-center justify-center rounded-chip text-bw-muted opacity-0 transition-[opacity,color,background-color] duration-150 hover:bg-bw-subtle hover:text-bw-ink focus-visible:opacity-100 group-hover:opacity-100"
          onClick={handleCopy}
          title={copied ? "Copied" : "Copy"}
          type="button"
        >
          {copied ? (
            <Check className="text-bw-done" size={11} />
          ) : (
            <Copy size={11} />
          )}
        </button>
      </div>

      {html ? (
        // Shiki emits its own colours; branchwise-code strips the frame it
        // brings with them so only ours shows.
        <div
          className="branchwise-code overflow-x-auto px-2.5 py-2.5 font-mono text-[12.5px] leading-[1.6]"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output, generated from this text in-process
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-x-auto px-2.5 py-2.5 font-mono text-[12.5px] text-bw-ink leading-[1.6]">
          {text}
        </pre>
      )}
    </div>
  );
}
