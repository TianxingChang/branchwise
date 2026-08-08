import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  readonly args: string[];
  readonly stderr: string;

  constructor(args: string[], stderr: string, options?: ErrorOptions) {
    super(stderr.trim() || `git ${args.join(" ")} failed`, options);
    this.args = args;
    this.name = "GitError";
    this.stderr = stderr;
  }
}

/**
 * One queue per repository.
 *
 * An agent and the user can both be running git at the same moment, and
 * concurrent ref updates collide on `index.lock`. Serialising per repo is far
 * cheaper than diagnosing the resulting intermittent failures.
 */
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(
    key,
    next.catch(() => undefined)
  );
  return next;
}

export interface RunGitOptions {
  /** Repository the command belongs to; commands sharing a key never overlap. */
  queueKey?: string;
  timeoutMs?: number;
}

export function runGit(
  cwd: string,
  args: string[],
  options: RunGitOptions = {}
): Promise<string> {
  const run = async () => {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd,
        maxBuffer: 16 * 1024 * 1024,
        timeout: options.timeoutMs ?? 20_000,
      });
      return stdout;
    } catch (error) {
      const stderr =
        typeof error === "object" && error !== null && "stderr" in error
          ? String((error as { stderr: unknown }).stderr)
          : String(error);
      // The cause is attached through GitError's constructor, which the rule
      // cannot see through.
      // biome-ignore lint/style/useErrorCause: see above
      throw new GitError(args, stderr, { cause: error });
    }
  };

  return options.queueKey ? enqueue(options.queueKey, run) : run();
}

/** Runs a command whose failure is meaningful rather than exceptional. */
export async function tryGit(
  cwd: string,
  args: string[],
  options: RunGitOptions = {}
): Promise<string | null> {
  try {
    return await runGit(cwd, args, options);
  } catch {
    return null;
  }
}
