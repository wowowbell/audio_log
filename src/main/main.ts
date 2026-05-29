import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from "electron";
import path from "node:path";
import { CsvCache } from "./services/CsvCache";
import type { GoToGlitchRequest } from "../shared/types";

let mainWindow: BrowserWindow | null = null;
let cache: CsvCache;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 700,
    title: "CSV Audio Log Viewer",
    backgroundColor: "#111417",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) {
    void mainWindow.loadURL(devServer);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  cache = new CsvCache(app.getPath("userData"));
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function registerIpc() {
  ipcMain.handle("csv:open", async () => {
    const options: OpenDialogOptions = {
      title: "Open Total Phase CSV",
      properties: ["openFile"],
      filters: [{ name: "CSV files", extensions: ["csv"] }]
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);

    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, error: "No file selected" };
    }

    try {
      const summary = await cache.openCsv(result.filePaths[0]);
      const timeline = cache.getTimeline(summary.id);
      return { ok: true, summary, timeline };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle("csv:window", (_event, fileId: number, centerUs: number, zoom: number) => {
    return cache.loadWindow(fileId, centerUs, zoom);
  });

  ipcMain.handle("csv:timeline", (_event, fileId: number) => {
    return cache.getTimeline(fileId);
  });

  ipcMain.handle("csv:detail", (_event, fileId: number, timeUs: number) => {
    return cache.getRowDetail(fileId, timeUs);
  });

  ipcMain.handle("csv:glitch", (_event, request: GoToGlitchRequest) => {
    return cache.goToGlitch(request);
  });
}
