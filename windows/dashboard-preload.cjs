// dashboard（sidecar 的本地网页）在 Windows 壳里能用的原生能力：目前只有开机自启
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fomomoNative", Object.freeze({
  autoStart: (value) => ipcRenderer.invoke("fomomo:auto-start", typeof value === "boolean" ? value : null),
}));
