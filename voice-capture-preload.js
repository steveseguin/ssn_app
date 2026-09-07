const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("voiceCapture", {
  send: (kind, data) => ipcRenderer.invoke("voice:capture", kind, data),
  onControl: (callback) =>
    ipcRenderer.on("voice:capture-control", (_, data) => callback(data)),
});
