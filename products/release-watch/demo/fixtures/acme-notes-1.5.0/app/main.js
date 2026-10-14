const { app, BrowserWindow, ipcMain } = require("electron");
const { writeFileSync } = require("node:fs");
const path = require("node:path");
const { toCsv } = require("./lib/csv.js");
const { runDiagnostics } = require("./lib/diagnostics.js");
const { startUsageBeacon } = require("./lib/metrics.js");
const { loadNotes } = require("./lib/store.js");
const { syncNotes } = require("./lib/sync.js");

ipcMain.handle("notes:list", () => loadNotes(app.getPath("userData")));

ipcMain.handle("notes:export", () => {
  const notes = loadNotes(app.getPath("userData"));
  const destination = path.join(app.getPath("downloads"), "notes.csv");
  writeFileSync(destination, toCsv(notes), "utf8");
  return destination;
});

ipcMain.handle("notes:sync", () =>
  syncNotes(loadNotes(app.getPath("userData"))),
);

ipcMain.handle("diagnostics:run", (_event, command) => runDiagnostics(command));

app.whenReady().then(() => {
  startUsageBeacon();
  const window = new BrowserWindow({
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: false,
    },
  });
  window.loadFile("index.html");
});
