/**
 * A worktree used to have exactly one shell, so its path *was* the session
 * key. Now it has as many as the user opens, and the key has to carry both.
 *
 * NUL is the separator because it is the one byte a POSIX path cannot contain,
 * so a key always splits back into the directory it belongs to. Anything
 * printable — '#', '::', '@' — is a legal filename character, and the day a
 * branch is named `feat#2` the key parses into a directory that does not exist
 * and the shell survives its own project closing.
 *
 * Built with fromCharCode rather than typed as a literal: a raw NUL byte in a
 * source file makes git treat the whole file as binary.
 */
const SEPARATOR = String.fromCharCode(0);

export function terminalKey(worktreePath: string, terminalId: string): string {
  return `${worktreePath}${SEPARATOR}${terminalId}`;
}

/**
 * The directory a key belongs to. A key with no separator is read as a bare
 * worktree path so that it still matches its own directory rather than
 * silently belonging to nothing.
 */
export function worktreeOfKey(key: string): string {
  const at = key.indexOf(SEPARATOR);
  return at === -1 ? key : key.slice(0, at);
}

/** The terminal's own id. Empty for a bare path, which names no terminal. */
export function idOfKey(key: string): string {
  const at = key.indexOf(SEPARATOR);
  return at === -1 ? "" : key.slice(at + SEPARATOR.length);
}

/**
 * Whether a session belongs to a directory or one nested inside it. Compares
 * the *parsed worktree*, never the raw key: matching the key directly is how
 * closing a project tab would leave every terminal but the first running.
 *
 * The trailing slash is what keeps "/repo-two" from counting as under "/repo".
 */
export function isKeyUnder(key: string, prefix: string): boolean {
  const worktree = worktreeOfKey(key);
  return worktree === prefix || worktree.startsWith(`${prefix}/`);
}
