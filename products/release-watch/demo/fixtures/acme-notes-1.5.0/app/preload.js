const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("notes", {
  list: () => ipcRenderer.invoke("notes:list"),
  exportCsv: () => ipcRenderer.invoke("notes:export"),
  sync: () => ipcRenderer.invoke("notes:sync"),
  runDiagnostics: (command) => ipcRenderer.invoke("diagnostics:run", command),
});
