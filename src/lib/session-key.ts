/**
 * Keys that name one session among several belonging to a directory.
 *
 * A worktree used to have exactly one shell and one conversation, so its path
 * *was* the key. It now has as many of each as the user opens, and a key has
 * to carry both the directory and which session it is.
 *
 * NUL is the separator because it is the one byte a POSIX path cannot contain,
 * so a key always splits back into the directory it belongs to. Anything
 * printable — '#', '::', '@' — is a legal filename character, and the day a
 * branch is named `feat#2` the key parses into a directory that does not exist
 * and the session outlives its own project closing.
 *
 * Built with fromCharCode rather than typed as a literal: a raw NUL byte in a
 * source file makes git treat the whole file as binary.
 */
const SEPARATOR = String.fromCharCode(0);

export function sessionKey(directory: string, sessionId: string): string {
  return `${directory}${SEPARATOR}${sessionId}`;
}

/**
 * The directory a key belongs to. A key with no separator is read as a bare
 * path so that it still matches its own directory rather than silently
 * belonging to nothing.
 */
export function directoryOfKey(key: string): string {
  const at = key.indexOf(SEPARATOR);
  return at === -1 ? key : key.slice(0, at);
}

/** The session's own id. Empty for a bare path, which names no session. */
export function idOfKey(key: string): string {
  const at = key.indexOf(SEPARATOR);
  return at === -1 ? "" : key.slice(at + SEPARATOR.length);
}

/**
 * Whether a session belongs to a directory or one nested inside it. Compares
 * the *parsed directory*, never the raw key: matching the key directly is how
 * closing a project would leave every session but the first running.
 *
 * The trailing slash is what keeps "/repo-two" from counting as under "/repo".
 */
export function isKeyUnder(key: string, prefix: string): boolean {
  const directory = directoryOfKey(key);
  return directory === prefix || directory.startsWith(`${prefix}/`);
}
