export const ARTIFACT_SAVE_DELAY_MS = 350;

/**
 * Debounces saves without ever letting two run at once.
 *
 * Keystrokes call `schedule`; the actual write happens once the input pauses.
 * Saves chain on a single promise so a slow write and the next one cannot
 * interleave, and a failed write marks the queue dirty again so the change
 * is retried rather than dropped. `flush` is for the moments that cannot
 * wait — switching artifacts, unmounting — and resolves when the disk is
 * caught up with the editor.
 */
export function createSaveQueue(save: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain = Promise.resolve();
  let dirty = false;

  const persist = () => {
    if (!dirty) {
      return chain;
    }

    dirty = false;
    chain = chain
      .catch(() => {
        // The previous link already flagged itself; this link still runs.
      })
      .then(async () => {
        try {
          await save();
        } catch (error) {
          dirty = true;
          throw error;
        }
      });
    return chain;
  };

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    return persist();
  };

  const schedule = () => {
    dirty = true;
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      persist().catch(() => {
        // Retried on the next schedule or flush; dirty is already set.
      });
    }, ARTIFACT_SAVE_DELAY_MS);
  };

  const discard = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    dirty = false;
  };

  return {
    /** Forgets pending changes. For after a delete, when a late save would
     * resurrect the file the user just removed. */
    discard,
    dispose: () => flush().catch(() => undefined),
    flush,
    schedule,
  };
}

export type SaveQueue = ReturnType<typeof createSaveQueue>;
