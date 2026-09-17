// dashboard（sidecar 的本地网页）在 Windows 壳里能用的原生能力：开机自启、版本与快捷键信息
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fomomoNative", Object.freeze({
  autoStart: (value) => ipcRenderer.invoke("fomomo:auto-start", typeof value === "boolean" ? value : null),
  appInfo: () => ipcRenderer.invoke("fomomo:app-info"),
}));
