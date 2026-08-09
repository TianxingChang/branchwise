import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ARTIFACT_SAVE_DELAY_MS,
  createSaveQueue,
} from "@/lib/artifacts/save-queue";

describe("createSaveQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("coalesces a burst of schedules into one save", async () => {
    const save = vi.fn(() => Promise.resolve());
    const queue = createSaveQueue(save);

    queue.schedule();
    queue.schedule();
    queue.schedule();
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(ARTIFACT_SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  test("flush saves immediately and only when dirty", async () => {
    const save = vi.fn(() => Promise.resolve());
    const queue = createSaveQueue(save);

    await queue.flush();
    expect(save).not.toHaveBeenCalled();

    queue.schedule();
    await queue.flush();
    expect(save).toHaveBeenCalledTimes(1);

    // The scheduled timer was cancelled by the flush.
    await vi.advanceTimersByTimeAsync(ARTIFACT_SAVE_DELAY_MS * 2);
    expect(save).toHaveBeenCalledTimes(1);
  });

  test("a failed save stays dirty and is retried by the next flush", async () => {
    let failures = 1;
    const save = vi.fn(() => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error("disk full"));
      }
      return Promise.resolve();
    });
    const queue = createSaveQueue(save);

    queue.schedule();
    await vi.advanceTimersByTimeAsync(ARTIFACT_SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);

    await expect(queue.flush()).resolves.toBeUndefined();
    expect(save).toHaveBeenCalledTimes(2);
  });

  test("discard forgets the pending change entirely", async () => {
    const save = vi.fn(() => Promise.resolve());
    const queue = createSaveQueue(save);

    queue.schedule();
    queue.discard();

    await vi.advanceTimersByTimeAsync(ARTIFACT_SAVE_DELAY_MS * 2);
    await queue.flush();
    expect(save).not.toHaveBeenCalled();
  });

  test("saves never overlap: the next waits for the previous", async () => {
    const releases: (() => void)[] = [];
    let running = 0;
    let sawOverlap = false;

    const save = vi.fn(() => {
      running += 1;
      if (running > 1) {
        sawOverlap = true;
      }
      return new Promise<void>((resolve) => {
        releases.push(() => {
          running -= 1;
          resolve();
        });
      });
    });

    const queue = createSaveQueue(save);

    queue.schedule();
    await vi.advanceTimersByTimeAsync(ARTIFACT_SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);

    // A second change arrives while the first save is still in flight.
    queue.schedule();
    await vi.advanceTimersByTimeAsync(ARTIFACT_SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);

    releases.shift()?.();
    await vi.runAllTimersAsync();
    expect(save).toHaveBeenCalledTimes(2);
    releases.shift()?.();
    await vi.runAllTimersAsync();
    expect(sawOverlap).toBe(false);
  });
});
