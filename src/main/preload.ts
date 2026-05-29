import { contextBridge, ipcRenderer } from "electron";
import type { GoToGlitchRequest, ViewerApi } from "../shared/types";

const api: ViewerApi = {
  openCsv: () => ipcRenderer.invoke("csv:open"),
  loadWindow: (fileId: number, centerUs: number, zoom: number) =>
    ipcRenderer.invoke("csv:window", fileId, centerUs, zoom),
  getTimeline: (fileId: number) => ipcRenderer.invoke("csv:timeline", fileId),
  getRowDetail: (fileId: number, timeUs: number) => ipcRenderer.invoke("csv:detail", fileId, timeUs),
  goToGlitch: (request: GoToGlitchRequest) => ipcRenderer.invoke("csv:glitch", request)
};

contextBridge.exposeInMainWorld("audioLog", api);
