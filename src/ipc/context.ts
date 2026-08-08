import { os } from "@orpc/server";
import type { BrowserWindow } from "electron";

class IPCContext {
  mainWindow: BrowserWindow | undefined;

  setMainWindow(window: BrowserWindow) {
    this.mainWindow = window;
  }

  /**
   * Resolves the window per request, not when the middleware is defined.
   *
   * Handler modules call this at import time, which is before the window
   * exists — and on macOS the window can be recreated after being closed, so a
   * window captured once would go stale.
   */
  get mainWindowContext() {
    return os.middleware(({ next }) => {
      const window = this.mainWindow;
      if (!window) {
        throw new Error("Main window is not set in IPC context.");
      }

      return next({ context: { window } });
    });
  }
}

export const ipcContext = new IPCContext();
