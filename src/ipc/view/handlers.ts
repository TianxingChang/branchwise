import { eventIterator, os } from "@orpc/server";
import { z } from "zod";
import { isHttpUrl } from "@/lib/view/url";
import { viewBoundsSchema, viewStateSchema } from "@/types/view";
import { ipcContext } from "../context";
import {
  destroyViewsUnder,
  goBack,
  goForward,
  hideView,
  navigateView,
  openView,
  reloadView,
  setBounds,
  snapshotOf,
  subscribe,
  unsubscribe,
} from "./manager";

const keyInput = z.object({
  /** The worktree directory — the view's identity, like the terminal's. */
  worktreePath: z.string().min(1),
});

const urlInput = keyInput.extend({
  // The renderer normalizes before sending; this is the trust boundary that
  // keeps a bug there from turning the preview into a file: or app: window.
  url: z.string().refine(isHttpUrl, "Only http and https pages can be shown."),
});

/**
 * Streams one worktree's page state. The current state is replayed first, so
 * a re-opened tab paints its toolbar without waiting for the page to change.
 */
export const attach = os
  .input(keyInput)
  .output(eventIterator(viewStateSchema))
  .handler(async function* ({ input, signal }) {
    // Subscribe before replaying: a change that lands in between then waits
    // in the queue instead of being missed.
    const queue = subscribe(input.worktreePath);
    try {
      for (const event of snapshotOf(input.worktreePath)) {
        yield event;
      }
      for await (const event of queue.iterate(signal)) {
        yield event;
      }
    } finally {
      unsubscribe(input.worktreePath, queue);
    }
  });

export const open = os
  .use(ipcContext.mainWindowContext)
  .input(urlInput)
  .output(z.object({ ok: z.literal(true) }))
  .handler(async ({ context, input }) => {
    await openView(input.worktreePath, input.url, context.window);
    return { ok: true as const };
  });

export const navigate = os
  .use(ipcContext.mainWindowContext)
  .input(urlInput)
  .output(z.object({ ok: z.literal(true) }))
  .handler(async ({ context, input }) => {
    await navigateView(input.worktreePath, input.url, context.window);
    return { ok: true as const };
  });

export const back = os
  .input(keyInput)
  .output(z.object({ ok: z.literal(true) }))
  .handler(({ input }) => {
    goBack(input.worktreePath);
    return { ok: true as const };
  });

export const forward = os
  .input(keyInput)
  .output(z.object({ ok: z.literal(true) }))
  .handler(({ input }) => {
    goForward(input.worktreePath);
    return { ok: true as const };
  });

export const reload = os
  .input(keyInput)
  .output(z.object({ ok: z.literal(true) }))
  .handler(({ input }) => {
    reloadView(input.worktreePath);
    return { ok: true as const };
  });

export const place = os
  .input(keyInput.extend({ bounds: viewBoundsSchema }))
  .output(z.object({ ok: z.literal(true) }))
  .handler(({ input }) => {
    setBounds(input.worktreePath, input.bounds);
    return { ok: true as const };
  });

export const hide = os
  .input(keyInput)
  .output(z.object({ ok: z.literal(true) }))
  .handler(({ input }) => {
    hideView(input.worktreePath);
    return { ok: true as const };
  });

/** Used when a project tab closes, so no page is left rendering behind it. */
export const destroyUnder = os
  .input(z.object({ prefix: z.string().min(1) }))
  .output(z.object({ ok: z.literal(true) }))
  .handler(({ input }) => {
    destroyViewsUnder(input.prefix);
    return { ok: true as const };
  });
