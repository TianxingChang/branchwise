import { type BrowserWindow, shell, WebContentsView } from "electron";
import { EventQueue } from "@/lib/queue";
import type { ViewBounds, ViewState } from "@/types/view";

/** Matches the viewport card's rounded corners in view-tab.tsx. */
const VIEW_BORDER_RADIUS = 10;

/** A navigation superseded by another one — not a failure anyone chose. */
const ERR_ABORTED = -3;

interface Session {
  /** Why the last load failed, cleared by the next attempt. */
  failure: string | null;
  view: WebContentsView;
  window: BrowserWindow;
}

const sessions = new Map<string, Session>();

/**
 * Subscriptions belong to the *worktree*, not to the panel component showing
 * it — the component unmounts on every tab switch while the page lives on.
 */
const subscribers = new Map<string, Set<EventQueue<ViewState>>>();

function stateOf(key: string): ViewState | null {
  const session = sessions.get(key);
  if (!session || session.view.webContents.isDestroyed()) {
    return null;
  }
  const contents = session.view.webContents;
  return {
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
    failure: session.failure,
    loading: contents.isLoading(),
    title: contents.getTitle(),
    url: contents.getURL(),
  };
}

function broadcast(key: string): void {
  const queues = subscribers.get(key);
  if (!queues || queues.size === 0) {
    return;
  }
  const state = stateOf(key);
  if (!state) {
    return;
  }
  for (const queue of queues) {
    queue.push(state);
  }
}

function isHttpProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

/** mailto:/tel: leave for the OS; anything else non-http is dropped. */
function handOffToSystem(url: string): void {
  try {
    const { protocol } = new URL(url);
    if (protocol === "mailto:" || protocol === "tel:") {
      shell.openExternal(url).catch(() => undefined);
    }
  } catch {
    // Malformed — nowhere safe to send it.
  }
}

function createSession(key: string, window: BrowserWindow): Session {
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // The page is arbitrary web content — usually the user's own dev
      // server, but nothing here may assume that. Full sandbox, own
      // partition, no preload: the strictest shell Electron offers.
      partition: "persist:branchwise-view",
      sandbox: true,
    },
  });
  view.setBorderRadius(VIEW_BORDER_RADIUS);
  view.setBackgroundColor("#ffffff");

  const session: Session = { failure: null, view, window };
  const contents = view.webContents;

  // Popups collapse into this view: a preview pane is not a browser, so one
  // page is all there is. Non-http schemes go to the OS or nowhere.
  contents.setWindowOpenHandler(({ url }) => {
    try {
      if (isHttpProtocol(new URL(url).protocol)) {
        setImmediate(() => {
          contents.loadURL(url).catch(() => undefined);
        });
      } else {
        handOffToSystem(url);
      }
    } catch {
      // Malformed popup URL — ignore.
    }
    return { action: "deny" };
  });

  contents.on("will-navigate", (event, url) => {
    try {
      if (!isHttpProtocol(new URL(url).protocol)) {
        event.preventDefault();
        handOffToSystem(url);
      }
    } catch {
      event.preventDefault();
    }
  });

  contents.on("did-start-loading", () => {
    session.failure = null;
    broadcast(key);
  });
  contents.on("did-stop-loading", () => broadcast(key));
  contents.on("did-navigate", () => broadcast(key));
  contents.on("did-navigate-in-page", () => broadcast(key));
  contents.on("page-title-updated", () => broadcast(key));
  contents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === ERR_ABORTED) {
        return;
      }
      session.failure = errorDescription || `error ${errorCode}`;
      broadcast(key);
    }
  );

  window.contentView.addChildView(view);
  sessions.set(key, session);
  return session;
}

function ensureSession(key: string, window: BrowserWindow): Session {
  const existing = sessions.get(key);
  if (existing && !existing.view.webContents.isDestroyed()) {
    return existing;
  }
  if (existing) {
    sessions.delete(key);
  }
  return createSession(key, window);
}

/**
 * Shows the worktree's page, creating the view on first use. A remount with
 * the address the view is already on is a no-op, so switching panel tabs
 * neither reloads the page nor loses its state.
 */
export async function openView(
  key: string,
  url: string,
  window: BrowserWindow
): Promise<void> {
  const session = ensureSession(key, window);
  const contents = session.view.webContents;
  if (contents.getURL() === url) {
    broadcast(key);
    return;
  }
  // A failed load already announced itself via did-fail-load; the rejected
  // promise here is the same news twice.
  await contents.loadURL(url).catch(() => undefined);
}

/** Deliberate navigation: same address means "load it again". */
export async function navigateView(
  key: string,
  url: string,
  window: BrowserWindow
): Promise<void> {
  const session = ensureSession(key, window);
  await session.view.webContents.loadURL(url).catch(() => undefined);
}

export function goBack(key: string): void {
  sessions.get(key)?.view.webContents.navigationHistory.goBack();
}

export function goForward(key: string): void {
  sessions.get(key)?.view.webContents.navigationHistory.goForward();
}

export function reloadView(key: string): void {
  sessions.get(key)?.view.webContents.reload();
}

export function setBounds(key: string, bounds: ViewBounds): void {
  const session = sessions.get(key);
  if (session && !session.view.webContents.isDestroyed()) {
    session.view.setBounds(bounds);
  }
}

/** Zero-sized rather than destroyed: the page keeps living off-screen. */
export function hideView(key: string): void {
  setBounds(key, { height: 0, width: 0, x: 0, y: 0 });
}

export function subscribe(key: string): EventQueue<ViewState> {
  // Only the newest state matters, so waiting entries collapse to one.
  const queue = new EventQueue<ViewState>({ merge: (_left, right) => right });
  const existing = subscribers.get(key) ?? new Set<EventQueue<ViewState>>();
  existing.add(queue);
  subscribers.set(key, existing);
  return queue;
}

export function unsubscribe(key: string, queue: EventQueue<ViewState>): void {
  const queues = subscribers.get(key);
  queues?.delete(queue);
  if (queues && queues.size === 0) {
    subscribers.delete(key);
  }
  queue.close();
}

/** What an attaching component needs to catch up: the current state, if any. */
export function snapshotOf(key: string): ViewState[] {
  const state = stateOf(key);
  return state ? [state] : [];
}

function destroy(key: string): void {
  const session = sessions.get(key);
  if (session) {
    sessions.delete(key);
    if (!session.window.isDestroyed()) {
      session.window.contentView.removeChildView(session.view);
    }
    if (!session.view.webContents.isDestroyed()) {
      session.view.webContents.close();
    }
  }
  for (const queue of subscribers.get(key) ?? []) {
    queue.close();
  }
  subscribers.delete(key);
}

/** Frees every view whose worktree lives under a directory. */
export function destroyViewsUnder(prefix: string): void {
  for (const key of [...sessions.keys(), ...subscribers.keys()]) {
    if (key === prefix || key.startsWith(`${prefix}/`)) {
      destroy(key);
    }
  }
}

export function destroyAllViews(): void {
  for (const key of [...sessions.keys(), ...subscribers.keys()]) {
    destroy(key);
  }
}
