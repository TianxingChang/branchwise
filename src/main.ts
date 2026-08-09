import path from "node:path";
import { app, BrowserWindow } from "electron";
import { ipcMain } from "electron/main";
import {
  installExtension,
  REACT_DEVELOPER_TOOLS,
} from "electron-devtools-installer";
import { UpdateSourceType, updateElectronApp } from "update-electron-app";
import { ipcContext } from "@/ipc/context";
import { IPC_CHANNELS, inDevelopment } from "./constants";
import { stopAllWatching } from "./ipc/files/watcher";
import { killAll } from "./ipc/terminal/manager";
import { destroyAllViews } from "./ipc/view/manager";
import { getBasePath } from "./utils/path";

/** Set to "owner/repo" once branchwise ships GitHub releases. */
const UPDATE_REPO = "";

function createWindow() {
  const basePath = getBasePath();
  const preload = path.join(basePath, "preload.js");
  const mainWindow = new BrowserWindow({
    backgroundColor: "#f5f5f3",
    height: 820,
    minHeight: 620,
    minWidth: 940,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    // Centres the traffic lights in the 40px tab strip.
    trafficLightPosition:
      process.platform === "darwin" ? { x: 14, y: 14 } : undefined,
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

app.whenReady().then(() => {
  try {
    // The RPC channel must be listening before the window exists. The renderer
    // hands over its MessagePort the instant it loads, and a packaged build
    // loads from disk fast enough to win that race — the port is then dropped
    // and every IPC call hangs forever. Only reproducible outside dev.
    setupORPC();
    createWindow();
    checkForUpdates();
    // Not awaited: devtools are a convenience, not a startup dependency.
    installExtensions();
  } catch (error) {
    console.error("Error during app initialization:", error);
  }
});

// Shells outlive the windows that show them, so they need an explicit stop.
// Synchronous on purpose: Electron does not wait for an async quit handler, so
// a dynamic import here could lose the race and leave shells behind.
app.on("before-quit", () => {
  killAll();
  stopAllWatching();
  destroyAllViews();
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
