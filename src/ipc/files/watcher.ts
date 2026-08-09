import { type FSWatcher, watch } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { toTreePath } from "@/lib/files/scan-policy";
import { EventQueue } from "@/lib/queue";
import type { FileChange } from "@/types/files";
import { isInsideUnwalkedDirectory } from "./scan";

const DEBOUNCE_MS = 60;
/**
 * How long a watcher outlives its last subscriber.
 *
 * A recursive `fs.watch` is not instantly live — on macOS it takes a moment
 * before events start arriving, so anything that happens right after it starts
 * is simply missed. Switching a panel tab away and back would otherwise tear
 * the watcher down and pay that warm-up again, with a window where edits go
 * unreported.
 */
const IDLE_GRACE_MS = 10_000;

interface Watcher {
  fsWatcher: FSWatcher | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  pending: Set<string>;
  subscribers: Set<EventQueue<FileChange>>;
  timer: ReturnType<typeof setTimeout> | null;
}

const watchers = new Map<string, Watcher>();

function broadcast(root: string, change: FileChange) {
  for (const queue of watchers.get(root)?.subscribers ?? []) {
    queue.push(change);
  }
}

/**
 * Turns a filesystem event into what the tree needs to know.
 *
 * `fs.watch` says only that *something* happened to a name — creation, edit and
 * deletion all arrive the same way — so the answer comes from asking the disk
 * whether the path is still there.
 */
async function classify(root: string, relative: string): Promise<void> {
  try {
    const info = await stat(path.join(root, relative));
    broadcast(root, {
      kind: "changed",
      path: toTreePath(relative, info.isDirectory()),
    });
  } catch {
    // Gone. The tree keys directories and files differently, so tell it about
    // both spellings and let it ignore the one it does not have.
    broadcast(root, { kind: "removed", path: relative });
    broadcast(root, { kind: "removed", path: `${relative}/` });
  }
}

function flush(root: string) {
  const watcher = watchers.get(root);
  if (!watcher) {
    return;
  }

  const batch = [...watcher.pending];
  watcher.pending.clear();

  for (const relative of batch) {
    classify(root, relative);
  }
}

function schedule(root: string, relative: string) {
  const watcher = watchers.get(root);
  if (!watcher || isInsideUnwalkedDirectory(relative)) {
    return;
  }

  watcher.pending.add(relative);
  if (watcher.timer) {
    clearTimeout(watcher.timer);
  }
  watcher.timer = setTimeout(() => {
    watcher.timer = null;
    flush(root);
  }, DEBOUNCE_MS);
}

function start(root: string): Watcher {
  const watcher: Watcher = {
    fsWatcher: null,
    idleTimer: null,
    pending: new Set(),
    subscribers: new Set(),
    timer: null,
  };
  watchers.set(root, watcher);

  try {
    watcher.fsWatcher = watch(root, { recursive: true }, (_event, filename) => {
      if (filename) {
        schedule(root, filename.split(path.sep).join("/"));
      }
    });
    watcher.fsWatcher.on("error", () => undefined);
  } catch {
    // Recursive watching is unavailable on some platforms and filesystems; the
    // tree still works, it just stops updating on its own.
  }

  return watcher;
}

export function subscribeToChanges(root: string): EventQueue<FileChange> {
  const watcher = watchers.get(root) ?? start(root);

  if (watcher.idleTimer) {
    clearTimeout(watcher.idleTimer);
    watcher.idleTimer = null;
  }
  const queue = new EventQueue<FileChange>({
    // Repeated events for the same path collapse; different paths do not.
    merge: (left, right) =>
      left.kind === right.kind && left.path === right.path ? left : null,
  });

  watcher.subscribers.add(queue);
  return queue;
}

export function unsubscribeFromChanges(
  root: string,
  queue: EventQueue<FileChange>
): void {
  const watcher = watchers.get(root);
  if (!watcher) {
    return;
  }

  watcher.subscribers.delete(queue);
  queue.close();

  if (watcher.subscribers.size === 0 && !watcher.idleTimer) {
    watcher.idleTimer = setTimeout(() => stopWatching(root), IDLE_GRACE_MS);
  }
}

export function stopWatching(root: string): void {
  const watcher = watchers.get(root);
  if (!watcher) {
    return;
  }

  watcher.fsWatcher?.close();
  if (watcher.timer) {
    clearTimeout(watcher.timer);
  }
  if (watcher.idleTimer) {
    clearTimeout(watcher.idleTimer);
  }
  for (const queue of watcher.subscribers) {
    queue.close();
  }
  watchers.delete(root);
}

export function stopAllWatching(): void {
  for (const root of [...watchers.keys()]) {
    stopWatching(root);
  }
}
