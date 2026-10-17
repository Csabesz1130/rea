// Runs the public CLI on small Electron releases each test writes, for
// which handlers RW-E01 checks a renderer API against: each exposure of an
// API name against the handler of its own channel, a handler whose channel
// REA did not resolve as one that may serve an API, and one finding per
// group of process sites however many APIs reach it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ELECTRON,
  claims,
  finding,
  graded,
  writtenCompare,
} from "./cli-reach-run.mjs";
import { skip } from "./cli-run.mjs";

const compare = writtenCompare();

const RUN =
  'const { execFile } = require("node:child_process");\nexports.run = (args) => execFile("/usr/bin/git", args);\n';
const preload = (api) =>
  `const { contextBridge, ipcRenderer } = require("electron");\ncontextBridge.exposeInMainWorld("app", {\n${api}});\n`;
const window = (file) =>
  `new BrowserWindow({ webPreferences: { preload: path.join(__dirname, "${file}") } }).loadFile("index.html");\n`;
// An app whose two windows' preloads both expose app.run, each on its own
// channel, and whose lib/run.js runs git at startup.
const twoWindows = (handlers) => ({
  "main.js": `const { app, BrowserWindow, ipcMain } = require("electron");\nconst path = require("node:path");\nconst { run } = require("./lib/run.js");\n${handlers}app.whenReady().then(() => {\n  run(["gc"]);\n  ${window("preload.js")}  ${window("settings-preload.js")}});\n`,
  "preload.js": preload('  run: (a) => ipcRenderer.invoke("main:run", a),\n'),
  "settings-preload.js": preload(
    '  run: (a) => ipcRenderer.invoke("settings:run", a),\n',
  ),
  "lib/run.js": RUN,
});
const HANDLERS = (main) =>
  `ipcMain.handle("main:run", (_e, a) => ${main});\nipcMain.handle("settings:run", (_e, a) => a);\n`;

describe("compare: each exposure of a renderer API", { skip }, () => {
  it("checks every preload's exposure of an API against its own channel", () => {
    const result = compare(
      twoWindows(HANDLERS("a")),
      twoWindows(HANDLERS("run(a)")),
      ELECTRON,
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-E01", "critical"]]);
    assert.equal(
      finding(result, "RW-E01").title,
      'Renderer can now reach process execution via "main:run"',
    );
  });

  it("reports an API new in both preloads whose one handler runs a process", () => {
    const old = twoWindows("");
    delete old["settings-preload.js"];
    old["preload.js"] = preload("");
    const result = compare(old, twoWindows(HANDLERS("run(a)")), ELECTRON);
    assert.equal(result.result.status, 2, result.result.stderr);
    const found = finding(result, "RW-E01");
    assert.equal(
      found.title,
      'Renderer can reach process execution via "main:run"',
    );
    assert.match(found.summary, /exposes app\.run\(\) to web content/);
  });

  it("takes a handler whose channel REA did not resolve for one that may serve an API", () => {
    const app = (handler) => ({
      "main.js": `const { app, BrowserWindow, ipcMain } = require("electron");\nconst path = require("node:path");\nconst { run } = require("./lib/run.js");\nconst { CHANNELS } = require("./channels.js");\nipcMain.handle("app:list", () => []);\n${handler}app.whenReady().then(() => {\n  run(["gc"]);\n  ${window("preload.js")}});\n`,
      "preload.js": preload(
        `  list: () => ipcRenderer.invoke("app:list"),\n${handler ? '  sync: (a) => ipcRenderer.invoke("app:sync", a),\n' : ""}`,
      ),
      "channels.js": 'exports.CHANNELS = { SYNC: "app:sync" };\n',
      "lib/run.js": RUN,
    });
    const result = compare(
      app(""),
      app("ipcMain.handle(CHANNELS.SYNC, (_e, a) => run(a));\n"),
      ELECTRON,
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    const found = finding(result, "RW-E01");
    assert.equal(
      found.title,
      'Renderer may reach process execution via "app:sync"',
    );
    assert.match(
      found.summary,
      /a v1\.1\.0 handler whose channel REA did not resolve, which may serve it, may reach execFile\(\) in lib\/run\.js/,
    );
    assert.ok(
      found.unknowns.some((unknown) =>
        /found no v1\.1\.0 handler for "app:sync"; REA did not resolve the channel of the handler at main\.js:6/.test(
          unknown,
        ),
      ),
      JSON.stringify(found.unknowns),
    );
  });
});

describe("compare: one RW-E01 per group of process sites", { skip }, () => {
  it("names every API whose handler reaches a helper that newly runs a process", () => {
    const names = ["get", "list", "pin", "remove"];
    const app = (audit) => ({
      "main.js": `const { app, BrowserWindow, ipcMain } = require("electron");\nconst path = require("node:path");\nconst { audit } = require("./lib/audit.js");\n${names.map((name) => `ipcMain.handle("notes:${name}", (_e, a) => audit("${name}", a));\n`).join("")}app.whenReady().then(() => {\n  ${window("preload.js")}});\n`,
      "preload.js": preload(
        names
          .map(
            (name) =>
              `  ${name}: (a) => ipcRenderer.invoke("notes:${name}", a),\n`,
          )
          .join(""),
      ),
      "lib/audit.js": audit
        ? 'const { execFile } = require("node:child_process");\nexports.audit = (action) => execFile("/usr/bin/logger", ["-t", "acme", action]);\n'
        : "exports.audit = (action) => action;\n",
    });
    const result = compare(app(false), app(true), ELECTRON);
    assert.equal(result.result.status, 2, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-E01", "critical"]]);
    const found = finding(result, "RW-E01");
    assert.equal(
      found.title,
      'Renderer can now reach new process execution via "notes:get" and 3 other channels',
    );
    assert.match(
      found.summary,
      /3 other exposures of a renderer API reach it as well: app\.list\(\), app\.pin\(\), app\.remove\(\)\.$/,
    );
    const cited = found.evidence.filter((item) =>
      /creates a child process/.test(item.claim),
    );
    assert.equal(cited.length, 1);
    assert.equal(
      claims(found).match(/The handler reads audit/g).length,
      names.length,
    );
  });
});
