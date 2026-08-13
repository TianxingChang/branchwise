import MarkdownIt from "markdown-it";

export type MessageSegment =
  | { kind: "prose"; text: string }
  | {
      kind: "code";
      language: string | null;
      /** No closing fence yet: the block is still being written. */
      open: boolean;
      text: string;
    };

const FENCE = /^(?<marker>```|~~~)\s*(?<language>[\w+-]*)\s*$/;

/**
 * Splits an answer into prose and fenced code.
 *
 * Done here rather than left to the markdown renderer because a fence is the
 * one part of an answer that needs its own component — a header, a copy
 * button, a highlighter that loads its grammar on demand — and because an
 * answer arrives a token at a time. An unterminated fence is reported as
 * still open, so a block being written renders as a code block from its first
 * line instead of appearing as running text and reflowing a moment later.
 */
export function splitFences(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const lines = text.split("\n");

  let prose: string[] = [];
  let code: string[] | null = null;
  let language: string | null = null;
  let opener = "";

  const flushProse = () => {
    const joined = prose.join("\n").trim();
    if (joined.length > 0) {
      segments.push({ kind: "prose", text: joined });
    }
    prose = [];
  };

  for (const line of lines) {
    const fence = FENCE.exec(line.trim());

    if (code === null) {
      if (fence?.groups) {
        flushProse();
        code = [];
        opener = fence.groups.marker as string;
        language = fence.groups.language || null;
      } else {
        prose.push(line);
      }
      continue;
    }

    // Only the marker that opened the block can close it, so a ``` inside a
    // ~~~ block stays part of the code.
    if (fence?.groups && fence.groups.marker === opener) {
      segments.push({
        kind: "code",
        language,
        open: false,
        text: code.join("\n"),
      });
      code = null;
      language = null;
      continue;
    }

    code.push(line);
  }

  if (code === null) {
    flushProse();
  } else {
    segments.push({
      kind: "code",
      language,
      open: true,
      text: code.join("\n"),
    });
  }

  return segments;
}

/**
 * Prose to HTML.
 *
 * `html: false` is the load-bearing option: an answer is text a model wrote,
 * and raw HTML in it would otherwise reach the DOM. markdown-it also refuses
 * `javascript:` in links by default, which is the other half of the same
 * concern. Links still have to be intercepted where this is rendered — a
 * plain navigation in a renderer process replaces the app.
 */
const renderer = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  typographer: false,
});

export function renderProse(markdown: string): string {
  return renderer.render(markdown);
}
