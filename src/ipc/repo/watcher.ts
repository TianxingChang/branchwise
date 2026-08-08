import { existsSync, type FSWatcher, watch } from "node:fs";
import path from "node:path";
import { diffSnapshots, isEmptyDiff } from "@/lib/git/resolve";
import type { RepoInfo, RepoSnapshot, WorktreeEntry } from "@/types/branch";
import { branchOrigin, listWorktrees, resolveRepo } from "./repo";

const DEBOUNCE_MS = 150;
/** fs.watch misses events on some filesystems; this is the safety net. */
const POLL_MS = 5000;

/**
 * Holds the latest snapshot and lets any number of consumers follow it.
 *
 * Consumers receive the newest state rather than every intermediate one —
 * snapshots are complete, so a slow consumer skipping ahead loses nothing.
 */
class SnapshotStream {
  private latest: RepoSnapshot | null = null;
  private version = 0;
  private waiters: (() => void)[] = [];

  publish(snapshot: RepoSnapshot) {
    this.latest = snapshot;
    this.version += 1;
    const waiting = this.waiters;
    this.waiters = [];
    for (const wake of waiting) {
      wake();
    }
  }

  get current(): RepoSnapshot | null {
    return this.latest;
  }

  async *follow(signal?: AbortSignal): AsyncGenerator<RepoSnapshot> {
    let delivered = -1;

    while (!signal?.aborted) {
      if (this.latest !== null && this.version !== delivered) {
        delivered = this.version;
        yield this.latest;
        continue;
      }

      // Sequential by nature: this loop *is* the wait for the next change.
      // biome-ignore lint/performance/noAwaitInLoops: see above
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  }
}

/**
 * Watches one repository and republishes a full snapshot whenever it changes.
 *
 * The filesystem events are treated purely as "something happened" — every one
 * of them triggers a fresh read of git's own answer, which is then diffed
 * against the last snapshot. Nothing is published unless the diff is non-empty,
 * so branchwise's own writes do not echo back as updates.
 */
export class RepoWatcher {
  readonly repo: RepoInfo;

  private readonly stream = new SnapshotStream();
  private readonly watchers: FSWatcher[] = [];
  private readonly origins = new Map<string, string | null>();

  private worktrees: WorktreeEntry[] = [];
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;
  private refreshAgain = false;
  private subscribers = 0;

  constructor(repo: RepoInfo) {
    this.repo = repo;
  }

  async start() {
    await this.refresh();
    this.arm();
    this.poll = setInterval(() => this.refresh(), POLL_MS);
  }

  stop() {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers.length = 0;

    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = null;
    }
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
  }

  retain() {
    this.subscribers += 1;
  }

  release(): number {
    this.subscribers = Math.max(0, this.subscribers - 1);
    return this.subscribers;
  }

  get snapshot(): RepoSnapshot | null {
    return this.stream.current;
  }

  follow(signal?: AbortSignal) {
    return this.stream.follow(signal);
  }

  /** Forces a re-read, used right after branchwise itself mutates the repo. */
  async poke() {
    await this.refresh();
  }

  private arm() {
    const targets = [
      this.repo.commonDir,
      path.join(this.repo.commonDir, "refs", "heads"),
      path.join(this.repo.commonDir, "worktrees"),
    ];

    for (const target of targets) {
      if (!existsSync(target)) {
        // `worktrees/` only appears with the first linked worktree; the
        // non-recursive watch on commonDir will catch its creation and re-arm.
        continue;
      }
      try {
        const watcher = watch(
          target,
          { recursive: target !== this.repo.commonDir },
          () => this.schedule()
        );
        watcher.on("error", () => undefined);
        this.watchers.push(watcher);
      } catch {
        // A watch we cannot establish is covered by the poll.
      }
    }
  }

  private rearmIfNeeded() {
    const worktreesDir = path.join(this.repo.commonDir, "worktrees");
    const watched = this.watchers.length;
    if (watched < 3 && existsSync(worktreesDir)) {
      for (const watcher of this.watchers) {
        watcher.close();
      }
      this.watchers.length = 0;
      this.arm();
    }
  }

  private schedule() {
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.refresh();
    }, DEBOUNCE_MS);
  }

  private async refresh() {
    // Re-entrant: an fs event can fire while an earlier read is still awaiting
    // git, so these flags are set and read across suspension points.
    // biome-ignore lint/suspicious/noUnnecessaryConditions: see above
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }

    this.refreshing = true;
    try {
      await this.readAndPublish();
    } catch {
      // A transient git failure (mid-write index, repo momentarily locked) is
      // not worth surfacing; the next event or poll will pick the truth up.
    } finally {
      this.refreshing = false;
      // biome-ignore lint/suspicious/noUnnecessaryConditions: set across an await, see refresh()
      if (this.refreshAgain) {
        this.refreshAgain = false;
        this.refresh();
      }
    }
  }

  private async readAndPublish() {
    const worktrees = await listWorktrees(this.repo.root);
    const diff = diffSnapshots(this.worktrees, worktrees);
    const first = this.stream.current === null;

    if (!(first || isEmptyDiff(diff))) {
      this.rearmIfNeeded();
    }

    if (!first && isEmptyDiff(diff)) {
      return;
    }

    this.worktrees = worktrees;
    await this.syncOrigins(worktrees);

    const repo = (await resolveRepo(this.repo.root)) ?? this.repo;

    this.stream.publish({
      origins: Object.fromEntries(this.origins),
      repo,
      worktrees,
    });
  }

  /**
   * Provenance never changes once a branch exists, so it is read at most once
   * per branch. Entries for branches that no longer have a worktree are
   * dropped, which keeps the map bounded by the number of nodes.
   */
  private async syncOrigins(worktrees: WorktreeEntry[]) {
    const branches = worktrees
      .map((entry) => entry.branch)
      .filter((branch): branch is string => branch !== null);

    for (const branch of branches) {
      if (!this.origins.has(branch)) {
        // Serial on purpose: these share the repo's command queue anyway, and
        // provenance is read at most once per branch for the app's lifetime.
        // biome-ignore lint/performance/noAwaitInLoops: see above
        this.origins.set(branch, await branchOrigin(this.repo, branch));
      }
    }

    const live = new Set(branches);
    for (const branch of this.origins.keys()) {
      if (!live.has(branch)) {
        this.origins.delete(branch);
      }
    }
  }
}

const watchers = new Map<string, RepoWatcher>();

export async function acquireWatcher(repo: RepoInfo): Promise<RepoWatcher> {
  const existing = watchers.get(repo.root);
  if (existing) {
    existing.retain();
    return existing;
  }

  const watcher = new RepoWatcher(repo);
  watchers.set(repo.root, watcher);
  watcher.retain();
  await watcher.start();
  return watcher;
}

export function releaseWatcher(repo: RepoInfo) {
  const watcher = watchers.get(repo.root);
  if (!watcher) {
    return;
  }
  if (watcher.release() === 0) {
    watcher.stop();
    watchers.delete(repo.root);
  }
}

export function peekWatcher(root: string): RepoWatcher | undefined {
  return watchers.get(root);
}
