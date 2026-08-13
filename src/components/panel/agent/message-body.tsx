import { useEffect, useMemo, useRef } from "react";
import { openExternalLink } from "@/actions/shell";
import CodeBlock from "@/components/panel/agent/code-block";
import { renderProse, splitFences } from "@/lib/agent/markdown";

/** Only these ever reach the system browser. */
function isWebLink(href: string): boolean {
  try {
    const { protocol } = new URL(href);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

interface MessageBodyProps {
  text: string;
}

/**
 * An assistant answer: markdown prose, with fenced code in its own blocks.
 *
 * Segments are memoised on the text so a turn that is still streaming only
 * re-parses what changed, and the closed code blocks above the caret keep
 * their highlighted markup instead of being rebuilt on every token. Their keys
 * are built there too — position is the only identity a segment has, since two
 * blocks in one answer can hold the same code in the same language.
 */
export default function MessageBody({ text }: MessageBodyProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const segments = useMemo(
    () =>
      splitFences(text).map((segment, at) => ({
        ...segment,
        key: `${at}-${segment.kind}`,
      })),
    [text]
  );

  /**
   * Clicking a link in agent output navigates the renderer by default, which
   * replaces the whole app with whatever the model wrote. It is caught on the
   * way up and handed to the system browser instead, and only if it is a web
   * link — a `file:` or custom scheme is dropped.
   *
   * Bound to the element rather than passed as a JSX handler: this is not an
   * interactive control that happens to be a div, it is a guard on navigation
   * escaping from inside it.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const intercept = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement | null)?.closest("a");
      const href = anchor?.getAttribute("href");
      if (!href) {
        return;
      }

      event.preventDefault();
      if (isWebLink(href)) {
        openExternalLink(href);
      }
    };

    host.addEventListener("click", intercept);
    return () => host.removeEventListener("click", intercept);
  }, []);

  return (
    <div className="flex flex-col gap-2" ref={hostRef}>
      {segments.map((segment) =>
        segment.kind === "code" ? (
          <CodeBlock
            key={segment.key}
            language={segment.language}
            text={segment.text}
          />
        ) : (
          <div
            className="branchwise-markdown"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown-it with html:false — no raw HTML from the model reaches the DOM
            dangerouslySetInnerHTML={{ __html: renderProse(segment.text) }}
            key={segment.key}
          />
        )
      )}
    </div>
  );
}
