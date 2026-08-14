import path from "node:path";
import { app, BrowserWindow, nativeTheme } from "electron";
import { ipcMain } from "electron/main";
import {
  installExtension,
  REACT_DEVELOPER_TOOLS,
} from "electron-devtools-installer";
import { UpdateSourceType, updateElectronApp } from "update-electron-app";
import { ipcContext } from "@/ipc/context";
import {
  IPC_CHANNELS,
  inDevelopment,
  trafficLightY,
  WINDOW_CHROME,
} from "./constants";
import { reapStrays } from "./ipc/agent/pids";
import { stopAllWatching } from "./ipc/files/watcher";
import { killAll } from "./ipc/terminal/manager";
import { destroyAllViews } from "./ipc/view/manager";
import { getBasePath } from "./utils/path";

/** Set to "owner/repo" once branchwise ships GitHub releases. */
const UPDATE_REPO = "";

function createWindow() {
  const basePath = getBasePath();
  const preload = path.join(basePath, "preload.js");
  const isMacOS = process.platform === "darwin";
  const mainWindow = new BrowserWindow({
    // Painted, not transparent: the frame is opaque white, so there is no
    // blur behind it to reveal — and a transparent backing would show as a
    // black flash in the frames before the renderer paints.
    backgroundColor: "#ffffff",
    height: 820,
    minHeight: 620,
    minWidth: 940,
    titleBarStyle: isMacOS ? "hiddenInset" : "hidden",
    // Centres the traffic lights on the tab strip, which now floats inside
    // the frame's gutter rather than sitting flush against the window edge.
    trafficLightPosition: isMacOS
      ? { x: WINDOW_CHROME.TRAFFIC_LIGHT_X, y: trafficLightY() }
      : undefined,
    webPreferences: {
      contextIsolation: true,
      devTools: inDevelopment,
      nodeIntegration: true,
      nodeIntegrationInSubFrames: false,

      preload,
    },
    width: 1280,
  });
  ipcContext.setMainWindow(mainWindow);

  // Embedded pages are native children of this window, not DOM — they do not
  // go away with the renderer, so the window's close must take them along.
  mainWindow.on("close", () => destroyAllViews());

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(basePath, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
  }
}

async function installExtensions() {
  try {
    const result = await installExtension(REACT_DEVELOPER_TOOLS);
    console.log(`Extensions installed successfully: ${result.name}`);
  } catch {
    console.error("Failed to install extensions");
  }
}

function checkForUpdates() {
  // Kept from the template but inert until branchwise publishes releases —
  // pointing it at a repo we do not own would serve someone else's binary.
  if (!(app.isPackaged && UPDATE_REPO)) {
    return;
  }

  updateElectronApp({
    updateSource: {
      repo: UPDATE_REPO,
      type: UpdateSourceType.ElectronPublicUpdateService,
    },
  });
}

function setupORPC() {
  // Registered synchronously so the listener exists before any renderer can
  // hand over its port. The router itself is imported lazily, once a port
  // actually arrives — by then the window exists for handlers that need it.
  ipcMain.on(IPC_CHANNELS.START_ORPC_SERVER, async (event) => {
    const [serverPort] = event.ports;
    const { rpcHandler } = await import("./ipc/handler");

    serverPort.start();
    rpcHandler.upgrade(serverPort);
  });
}

// Not awaited by the caller: cleans up anything orphaned by a previous hard
// crash (atlas A3), but startup does not depend on it finishing. Its own
// guard: startup must never warn (or worse) over stray cleanup.
function reapStraysAtStartup(): void {
  reapStrays(path.join(app.getPath("userData"), "agent")).catch(
    () => undefined
  );
}

app.whenReady().then(() => {
  try {
    // The RPC channel must be listening before the window exists. The renderer
    // hands over its MessagePort the instant it loads, and a packaged build
    // loads from disk fast enough to win that race — the port is then dropped
    // and every IPC call hangs forever. Only reproducible outside dev.
    setupORPC();
    // The renderer pins this too, but not until React mounts, and a dark
    // system appearance would otherwise darken the window's own furniture for
    // those first frames.
    nativeTheme.themeSource = "light";
    createWindow();
    checkForUpdates();
    // Not awaited: devtools are a convenience, not a startup dependency.
    installExtensions();
    reapStraysAtStartup();
  } catch (error) {
    console.error("Error during app initialization:", error);
  }
});

// Shells stop synchronously (they always did); agents need a bounded async
// window: interrupt, SIGTERM, then SIGKILL via the pid file. The flag is set
// in the completion handler BEFORE quit() so the re-entrant quit passes, and
// a failed import must still quit — an unquittable app is worse than an
// unreaped agent (startup reap covers those).
let agentsShutDown = false;
app.on("before-quit", (event) => {
  killAll();
  stopAllWatching();
  destroyAllViews();
  if (!agentsShutDown) {
    event.preventDefault();
    import("./ipc/agent/manager")
      .then(({ shutdownAgents }) => shutdownAgents(2000))
      .catch(() => undefined)
      .finally(() => {
        agentsShutDown = true;
        app.quit();
      });
  }
});

//osX only
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
//osX only ends
