import { execFile } from "node:child_process";

/** Long enough for a heavy profile, short enough not to stall a first turn. */
const TIMEOUT_MS = 3000;

/**
 * Wraps the value so a profile that prints its own banner cannot be mistaken
 * for PATH — the very dotfiles that make this necessary are the chatty ones.
 */
const MARKER = "__branchwise_path__";

let cached: Promise<string[]> | null = null;

/** Pulls the PATH out of whatever else the shell's profile decided to print. */
export function parseShellPath(stdout: string): string[] {
  const match = new RegExp(`${MARKER}(.*)${MARKER}`, "s").exec(stdout);
  if (!match) {
    return [];
  }
  return match[1].split(":").filter((dir) => dir.length > 0);
}

/**
 * The PATH a terminal would have, as opposed to the one this process has.
 *
 * An app launched from the Finder inherits launchd's PATH — roughly
 * `/usr/bin:/bin:/usr/sbin:/sbin` — not the one the user's profile builds. So
 * a CLI installed by nvm, mise, or a package manager's own prefix is invisible
 * to the packaged app while being perfectly findable in a terminal, and the
 * agent reports "not installed" about something the user just used.
 *
 * Asked once and cached: it costs a shell startup, and the answer cannot
 * change without the app restarting anyway.
 */
export function loginShellPath(): Promise<string[]> {
  cached ??= read();
  return cached;
}

/** Test seam — the spawn itself is not worth faking anywhere else. */
export function resetLoginShellPathForTests(): void {
  cached = null;
}

function read(): Promise<string[]> {
  if (process.platform === "win32") {
    return Promise.resolve([]);
  }

  return new Promise((resolve) => {
    execFile(
      process.env.SHELL || "/bin/zsh",
      // -l so the profile that sets PATH is read at all. Interactive is
      // deliberately not asked for: -i makes some profiles wait on a prompt.
      ["-lc", `printf '${MARKER}%s${MARKER}' "$PATH"`],
      { timeout: TIMEOUT_MS },
      (error, stdout) => {
        // A profile that fails is the user's business, not something to
        // surface here — the agent simply stays as findable as it was.
        resolve(error ? [] : parseShellPath(stdout));
      }
    );
  });
}
