const { contextBridge, ipcRenderer } = require("electron");

const subscribe = (channel, callback) => {
  const handler = (_event, value) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld("fomomo", Object.freeze({
  bootstrap: () => ipcRenderer.invoke("fomomo:bootstrap"),
  detail: () => ipcRenderer.invoke("fomomo:detail"),
  onEvent: (callback) => subscribe("fomomo:event", callback),
  onStatus: (callback) => subscribe("fomomo:status", callback),
  send: (event) => ipcRenderer.send("fomomo:command", event),
  openDetail: (token) => ipcRenderer.send("fomomo:open-detail", token),
  closeDetail: () => ipcRenderer.send("fomomo:close-detail"),
  pinDetail: () => ipcRenderer.send("fomomo:pin-detail"),
  openDashboard: (tab = null) => ipcRenderer.send("fomomo:open-dashboard", tab),
  openExternal: (url) => ipcRenderer.send("fomomo:open-external", url),
  openGmgn: () => ipcRenderer.send("fomomo:open-gmgn"),
  openFomo: () => ipcRenderer.send("fomomo:open-fomo"),
  hidePanel: () => ipcRenderer.send("fomomo:hide-panel"),
  toggleCompact: (compact) => ipcRenderer.send("fomomo:compact", !!compact),
  setAlwaysOnTop: (value) => ipcRenderer.send("fomomo:always-on-top", !!value),
  resizePanel: (phase, edge, dx, dy) => ipcRenderer.send("fomomo:resize-panel", { phase, edge, dx, dy }),
}));
