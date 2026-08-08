/**
 * Maps a filename to the Shiki grammar that should highlight it.
 *
 * Kept deliberately small: every language listed here is loaded on demand, and
 * an unknown extension renders as plain text rather than guessing wrong and
 * colouring the file as something it is not.
 */
const BY_EXTENSION: Record<string, string> = {
  bash: "bash",
  c: "c",
  cjs: "javascript",
  cpp: "cpp",
  css: "css",
  go: "go",
  h: "c",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "jsonc",
  jsx: "jsx",
  kt: "kotlin",
  lua: "lua",
  md: "markdown",
  mdx: "markdown",
  mjs: "javascript",
  mts: "typescript",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  svelte: "svelte",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  vue: "vue",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

const BY_NAME: Record<string, string> = {
  ".bashrc": "bash",
  ".gitattributes": "ini",
  ".gitignore": "ini",
  ".npmrc": "ini",
  ".zshrc": "bash",
  dockerfile: "docker",
  makefile: "make",
};

export const PLAIN_TEXT = "text";

export function languageForFile(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1).toLowerCase();

  const byName = BY_NAME[base];
  if (byName) {
    return byName;
  }

  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    return PLAIN_TEXT;
  }

  return BY_EXTENSION[base.slice(dot + 1)] ?? PLAIN_TEXT;
}

export function isMarkdown(name: string): boolean {
  const language = languageForFile(name);
  return language === "markdown";
}
