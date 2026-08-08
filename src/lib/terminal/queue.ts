/**
 * An ordered, coalescing event queue consumed as an async iterator.
 *
 * A terminal cannot use the "latest wins" approach the repository watcher uses:
 * every byte matters and order is the whole meaning. Instead, adjacent data
 * chunks are merged while they wait, which bounds the queue by the number of
 * non-data events rather than by throughput, so a command printing megabytes
 * cannot grow it without limit.
 */
export interface Coalescable<T> {
  merge: (left: T, right: T) => T | null;
}

export class EventQueue<T> {
  private readonly pending: T[] = [];
  private readonly waiters: ((value: IteratorResult<T>) => void)[] = [];
  private readonly coalesce: Coalescable<T>;
  private closed = false;

  constructor(coalesce: Coalescable<T>) {
    this.coalesce = coalesce;
  }

  push(item: T): void {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: close() flips this from outside the call
    if (this.closed) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value: item });
      return;
    }

    const last = this.pending.at(-1);
    if (last !== undefined) {
      const merged = this.coalesce.merge(last, item);
      if (merged !== null) {
        this.pending[this.pending.length - 1] = merged;
        return;
      }
    }

    this.pending.push(item);
  }

  close(): void {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: set by a previous call
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined as never });
    }
  }

  get size(): number {
    return this.pending.length;
  }

  async *iterate(signal?: AbortSignal): AsyncGenerator<T> {
    while (!signal?.aborted) {
      const queued = this.pending.shift();
      if (queued !== undefined) {
        yield queued;
        continue;
      }

      // biome-ignore lint/suspicious/noUnnecessaryConditions: close() runs between iterations of this loop
      if (this.closed) {
        return;
      }

      // Sequential by nature: this await *is* the wait for the next event.
      // biome-ignore lint/performance/noAwaitInLoops: see above
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiters.push(resolve);
        signal?.addEventListener(
          "abort",
          () => resolve({ done: true, value: undefined as never }),
          { once: true }
        );
      });

      if (next.done) {
        return;
      }
      yield next.value;
    }
  }
}
