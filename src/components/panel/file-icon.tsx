import {
  Braces,
  FileArchive,
  FileCode2,
  File as FileIcon,
  FileImage,
  FileText,
  FileType2,
  Table,
} from "lucide-react";

type IconComponent = typeof FileIcon;

/**
 * Enough of a mapping to make a listing scannable at a glance. Anything not
 * named here falls back to a plain sheet rather than guessing wrong.
 */
const BY_EXTENSION: Record<string, IconComponent> = {
  avif: FileImage,
  c: FileCode2,
  cjs: FileCode2,
  css: FileCode2,
  csv: Table,
  cts: FileCode2,
  gif: FileImage,
  go: FileCode2,
  gz: FileArchive,
  h: FileCode2,
  html: FileCode2,
  ico: FileImage,
  jpeg: FileImage,
  jpg: FileImage,
  js: FileCode2,
  json: Braces,
  jsonc: Braces,
  jsx: FileCode2,
  lock: Braces,
  md: FileText,
  mdx: FileText,
  mjs: FileCode2,
  mts: FileCode2,
  pdf: FileType2,
  png: FileImage,
  py: FileCode2,
  rs: FileCode2,
  scss: FileCode2,
  sh: FileCode2,
  svg: FileImage,
  toml: Braces,
  ts: FileCode2,
  tsv: Table,
  tsx: FileCode2,
  txt: FileText,
  webp: FileImage,
  yaml: Braces,
  yml: Braces,
  zip: FileArchive,
  zsh: FileCode2,
};

/** Dotfiles have no extension but are still recognisable by name. */
const BY_NAME: Record<string, IconComponent> = {
  ".gitattributes": FileCode2,
  ".gitignore": FileCode2,
  ".npmrc": FileCode2,
  dockerfile: FileCode2,
  license: FileText,
  makefile: FileCode2,
};

export function iconForFile(name: string): IconComponent {
  const byName = BY_NAME[name.toLowerCase()];
  if (byName) {
    return byName;
  }

  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return FileIcon;
  }

  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? FileIcon;
}
