const { app, BrowserWindow, ipcMain } = require("electron");
const { writeFileSync } = require("node:fs");
const path = require("node:path");
const { toCsv } = require("./lib/csv.js");
const { loadNotes } = require("./lib/store.js");

ipcMain.handle("notes:list", () => loadNotes(app.getPath("userData")));

ipcMain.handle("notes:export", () => {
  const notes = loadNotes(app.getPath("userData"));
  const destination = path.join(app.getPath("downloads"), "notes.csv");
  writeFileSync(destination, toCsv(notes), "utf8");
  return destination;
});

app.whenReady().then(() => {
  const window = new BrowserWindow({
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  window.loadFile("index.html");
});
