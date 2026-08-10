import { ipc } from "@/ipc/manager";
import type { ViewBounds, ViewState } from "@/types/view";

/**
 * Opens a stream of the worktree's page state. The current state arrives
 * first, then every change, until the signal aborts.
 */
export function attachViewState(
  worktreePath: string,
  signal: AbortSignal
): Promise<AsyncIterable<ViewState>> {
  return ipc.client.view.attach({ worktreePath }, { signal });
}

/** Shows the page, loading it only if the view is not already on that URL. */
export function openView(
  worktreePath: string,
  url: string
): Promise<{ ok: true }> {
  return ipc.client.view.open({ url, worktreePath });
}

/** Loads the URL unconditionally — the retry and reload-on-enter path. */
export function navigateView(
  worktreePath: string,
  url: string
): Promise<{ ok: true }> {
  return ipc.client.view.navigate({ url, worktreePath });
}

export function viewBack(worktreePath: string): Promise<{ ok: true }> {
  return ipc.client.view.back({ worktreePath });
}

export function viewForward(worktreePath: string): Promise<{ ok: true }> {
  return ipc.client.view.forward({ worktreePath });
}

export function reloadView(worktreePath: string): Promise<{ ok: true }> {
  return ipc.client.view.reload({ worktreePath });
}

/** Places the native view over the given window-relative rectangle. */
export function placeView(
  worktreePath: string,
  bounds: ViewBounds
): Promise<{ ok: true }> {
  return ipc.client.view.place({ bounds, worktreePath });
}

/** Parks the view off-screen without unloading the page. */
export function hideView(worktreePath: string): Promise<{ ok: true }> {
  return ipc.client.view.hide({ worktreePath });
}

/** Frees every view under a directory — used when a project tab closes. */
export function destroyViewsUnder(prefix: string): Promise<{ ok: true }> {
  return ipc.client.view.destroyUnder({ prefix });
}
