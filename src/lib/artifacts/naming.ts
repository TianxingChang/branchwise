import type { ArtifactKind } from "@/types/artifacts";

/**
 * Maps a shelf document to the file that holds it.
 *
 * The file name is the whole record: name, kind (extension) and — via mtime —
 * when it changed. There is deliberately no index file beside these; an index
 * is one more thing for two windows, a parallel session, or a hand edit to
 * corrupt, and the directory listing already knows everything the shelf shows.
 */
export const ARTIFACT_EXTENSIONS: Record<ArtifactKind, string> = {
  canvas: ".tldr",
  note: ".md",
};

const MAX_NAME_LENGTH = 80;
/** Path separators and NUL can escape the shelf directory; nothing else can. */
const FORBIDDEN = /[\\/\0]/;

export function artifactFileName(kind: ArtifactKind, name: string): string {
  return `${name}${ARTIFACT_EXTENSIONS[kind]}`;
}

/** Reads a directory entry back into (kind, name), or null for other files. */
export function parseArtifactFileName(
  fileName: string
): { kind: ArtifactKind; name: string } | null {
  for (const [kind, extension] of Object.entries(ARTIFACT_EXTENSIONS)) {
    if (!fileName.endsWith(extension)) {
      continue;
    }
    const name = fileName.slice(0, -extension.length);
    if (sanitizeArtifactName(name) !== name) {
      return null;
    }
    return { kind: kind as ArtifactKind, name };
  }
  return null;
}

/**
 * Validates a display name, returning it trimmed — or null when no file
 * should be created from it. This validates rather than transforms: a name
 * that silently became a different name would desynchronise the caller's
 * idea of the artifact from the file that actually exists.
 */
export function sanitizeArtifactName(raw: string): string | null {
  const name = raw.trim();
  if (
    name.length === 0 ||
    name.length > MAX_NAME_LENGTH ||
    name.startsWith(".") ||
    FORBIDDEN.test(name)
  ) {
    return null;
  }
  return name;
}

/**
 * Finds a free name by suffixing " 2", " 3", … the way Finder does.
 * Comparison folds case because the shelf usually lives on APFS, where
 * "Note.md" and "note.md" are the same file.
 */
export function uniqueArtifactName(
  taken: ReadonlySet<string>,
  base: string
): string {
  const folded = new Set<string>();
  for (const name of taken) {
    folded.add(name.toLowerCase());
  }

  if (!folded.has(base.toLowerCase())) {
    return base;
  }

  let counter = 2;
  while (folded.has(`${base.toLowerCase()} ${counter}`)) {
    counter += 1;
  }
  return `${base} ${counter}`;
}
