import type { Highlighter } from "shiki";

/** Light-only, to match the rest of the surface. */
const THEME = "github-light";

let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLanguages = new Set<string>();

/**
 * One highlighter for the whole app, created on first use.
 *
 * Two deliberate choices:
 *
 * - The JavaScript regex engine rather than the default Oniguruma one, which
 *   fetches a WebAssembly binary. The renderer runs from `file://` in a
 *   packaged build, where that fetch is not something to rely on.
 * - No grammars up front. Shiki carries a TextMate grammar per language, and
 *   loading them all would cost megabytes for a panel that usually shows one
 *   file, so each arrives the first time something needs it.
 */
async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then((shiki) =>
      shiki.createHighlighter({
        engine: shiki.createJavaScriptRegexEngine({ forgiving: true }),
        langs: [],
        themes: [THEME],
      })
    );
  }
  return await highlighterPromise;
}

export async function highlightCode(
  text: string,
  language: string
): Promise<string> {
  const highlighter = await getHighlighter();

  if (!loadedLanguages.has(language)) {
    await highlighter.loadLanguage(
      language as Parameters<Highlighter["loadLanguage"]>[0]
    );
    loadedLanguages.add(language);
  }

  return highlighter.codeToHtml(text, { lang: language, theme: THEME });
}

/** Only used by tests, so one case cannot leak grammars into the next. */
export function resetHighlighter(): void {
  highlighterPromise = null;
  loadedLanguages.clear();
}
