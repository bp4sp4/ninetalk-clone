// Bridge for the license window (window.html). Only these calls reach the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("license", {
  view: () => ipcRenderer.invoke("license:view"),
  submit: (token) => ipcRenderer.invoke("license:submit", String(token)),
  recheck: () => ipcRenderer.invoke("license:recheck"),
  quit: () => ipcRenderer.invoke("license:quit"),
  onView: (callback) => ipcRenderer.on("license:view", (_event, view) => callback(view)),
});
