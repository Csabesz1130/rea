// Runs the public CLI on small Electron releases each test writes, for
// RW-E01: renderer APIs the component already exposed whose handler newly
// reaches process execution, old handlers whose channel REA did not resolve
// and sites whose command it did not resolve, the path a finding cites
// when a settled one reaches a site of the group, and the hedged title of
// a guessed reach.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  claims,
  desktop,
  ELECTRON,
  finding,
  graded,
  writtenCompare,
} from "./cli-reach-run.mjs";
import { skip } from "./cli-run.mjs";

const compare = writtenCompare();

const RUN =
  'const { execFile } = require("node:child_process");\nexports.run = (args) => execFile("/usr/bin/git", args);\n';
const PRELOAD =
  'const { contextBridge, ipcRenderer } = require("electron");\ncontextBridge.exposeInMainWorld("notes", {\n  sync: (a) => ipcRenderer.invoke("notes:sync", a),\n  gc: () => ipcRenderer.invoke("notes:gc"),\n});\n';
const desk = (handlers, extra = {}) => ({
  "desk/package.json": '{"name":"acme-desk","main":"main.js"}',
  "desk/preload.js": PRELOAD,
  "desk/main.js": `const { app, BrowserWindow, ipcMain } = require("electron");\nconst path = require("node:path");\n${handlers}app.whenReady().then(() => new BrowserWindow({ webPreferences: { preload: path.join(__dirname, "preload.js") } }).loadFile("index.html"));\n`,
  ...extra,
});
const tools = (git) => ({
  "tools/package.json": '{"name":"acme-tools","main":"src/server.js"}',
  "tools/src/server.js": `const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");\nconst server = new McpServer({ name: "a", version: "1" });\n${git ? 'const { run } = require("../lib/run.js");\nserver.registerTool("git", {}, async ({ args }) => ({ content: [], out: run(args) }));\n' : 'server.registerTool("echo", {}, async ({ t }) => ({ content: [{ type: "text", text: t }] }));\n'}`,
  ...(git ? { "tools/lib/run.js": RUN } : {}),
});
const manifest = (version) =>
  JSON.stringify({
    product: "Acme Suite",
    version,
    components: [
      { name: "desk", path: "desk" },
      { name: "tools", path: "tools" },
    ],
  });

describe("compare: renderer APIs a release keeps", { skip }, () => {
  it("reports an existing API whose handler now reaches a process site that moved in from another component", () => {
    const result = compare(
      {
        "release-watch.json": manifest("1.0.0"),
        ...desk(
          'ipcMain.handle("notes:sync", (_e, a) => fetch("https://sync.acme.example/" + a));\nipcMain.handle("notes:gc", () => null);\n',
        ),
        ...tools(true),
      },
      {
        "release-watch.json": manifest("1.1.0"),
        ...desk(
          'const { run } = require("./lib/run.js");\nipcMain.handle("notes:sync", (_e, a) => run(a));\nipcMain.handle("notes:gc", () => null);\n',
          { "desk/lib/run.js": RUN },
        ),
        ...tools(false),
      },
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    const desktop = result.report.findings.filter(
      (item) => item.component === "desk",
    );
    assert.deepEqual(
      desktop.map((item) => [item.rule, item.severity, item.title]),
      [
        [
          "RW-E01",
          "critical",
          'Renderer can now reach new process execution via "notes:sync"',
        ],
      ],
    );
    assert.match(
      desktop[0].summary,
      /keeps notes\.sync\(\) for web content, and its handler now reaches execFile\(\) in lib\/run\.js/,
    );
    assert.match(
      claims(desktop[0]),
      /Release Watch connected the v1\.0\.0 handler for "notes:sync" to no execFile\(\) running \/usr\/bin\/git/,
    );
  });

  it("reports an existing API that newly reaches a process site, not one that already reached its command", () => {
    const main = (sync, gc) =>
      `const { app, ipcMain, BrowserWindow } = require("electron");\nconst { run } = require("./lib/run.js");\nipcMain.handle("ping", () => "pong");\nipcMain.handle("notes:sync", ${sync});\nipcMain.handle("notes:gc", ${gc});\napp.whenReady().then(() => new BrowserWindow({ webPreferences: { preload: __dirname + "/preload.js" } }).loadFile("index.html"));\n`;
    const preload =
      'const { contextBridge, ipcRenderer } = require("electron");\ncontextBridge.exposeInMainWorld("api", { ping: () => ipcRenderer.invoke("ping"), sync: (a) => ipcRenderer.invoke("notes:sync", a), gc: () => ipcRenderer.invoke("notes:gc") });\n';
    const release = (sync, gc) => ({
      "main.js": main(sync, gc),
      "preload.js": preload,
      "lib/run.js": RUN,
    });
    const result = compare(
      release(
        '(_e, a) => fetch("https://sync.acme.example/" + a)',
        '() => run(["gc"])',
      ),
      release(
        "(_e, a) => run(a)",
        'async () => { await null; return run(["gc", "--prune=now"]); }',
      ),
      ELECTRON,
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-E01", "critical"]]);
    assert.equal(
      finding(result, "RW-E01").title,
      'Renderer can now reach process execution via "notes:sync"',
    );
  });
});

// One app whose lib/run.js runs git with a configurable binary and any
// binary a caller names, neither a command REA resolves, and rsync and git.
const RUN_ANY =
  'const { execFile } = require("node:child_process");\nconst cfg = { bin: process.env.ACME_GIT || "/usr/bin/git" };\nexports.run = (args) => execFile(cfg.bin, args);\nexports.runAny = (bin, args) => execFile(bin, args);\nexports.rsync = (args) => execFile("/usr/bin/rsync", args);\nexports.git = (args) => execFile("/usr/bin/git", args);\n';
const SYNC_PRELOAD =
  'const { contextBridge, ipcRenderer } = require("electron");\ncontextBridge.exposeInMainWorld("notes", { sync: (a) => ipcRenderer.invoke("notes:sync", a) });\n';
const syncApp = (handler, { run = RUN_ANY, extra = {} } = {}) => ({
  "main.js": `const { app, ipcMain, BrowserWindow } = require("electron");\nconst { run, runAny, rsync, git } = require("./lib/run.js");\n${handler}app.whenReady().then(() => {\n  run(["gc"]); runAny("/usr/bin/true", []); rsync([]); git([]);\n  new BrowserWindow({ webPreferences: { preload: __dirname + "/preload.js" } }).loadFile("index.html");\n});\n`,
  "preload.js": SYNC_PRELOAD,
  "lib/run.js": run,
  ...extra,
});
const deskFindings = (result) =>
  result.report.findings.map((item) => [item.rule, item.title]);

describe(
  "compare: kept APIs whose old channel REA did not resolve",
  { skip },
  () => {
    it("compares a kept API with the old handlers whose channel REA did not resolve", () => {
      const old = syncApp(
        'const CHANNELS = require("./channels.js");\nipcMain.handle(CHANNELS.SYNC, (_e, a) => rsync(a));\n',
        {
          extra: {
            "channels.js": 'exports.SYNC = ["notes", "sync"].join(":");\n',
          },
        },
      );
      const same = compare(
        old,
        syncApp('ipcMain.handle("notes:sync", (_e, a) => rsync(a));\n'),
        ELECTRON,
      );
      assert.equal(same.result.status, 0, same.result.stderr);
      assert.deepEqual(
        deskFindings(same).filter(([rule]) => rule === "RW-E01"),
        [],
      );
      const other = compare(
        old,
        syncApp('ipcMain.handle("notes:sync", (_e, a) => git(a));\n'),
        ELECTRON,
      );
      assert.equal(other.result.status, 2, other.result.stderr);
      const found = finding(other, "RW-E01");
      assert.equal(
        found.title,
        'Renderer can now reach process execution via "notes:sync"',
      );
      assert.match(
        found.summary,
        /Release Watch connected the one v1\.0\.0 main-process handler whose channel REA did not resolve to no execFile\(\) with this command/,
      );
      assert.ok(
        found.unknowns.some((unknown) =>
          /found no v1\.0\.0 handler by this API's channel/.test(unknown),
        ),
        JSON.stringify(found.unknowns),
      );
    });

    it("reports a site only some old handlers whose channel REA did not resolve reached", () => {
      const channels = {
        "channels.js":
          'exports.SYNC = ["notes", "sync"].join(":");\nexports.GC = ["notes", "gc"].join(":");\n',
      };
      const result = compare(
        syncApp(
          'const CHANNELS = require("./channels.js");\nipcMain.handle(CHANNELS.SYNC, (_e, a) => rsync(a));\nipcMain.handle(CHANNELS.GC, (_e, a) => git(a));\n',
          { extra: channels },
        ),
        syncApp(
          'const CHANNELS = require("./channels.js");\nipcMain.handle("notes:sync", (_e, a) => git(a));\nipcMain.handle(CHANNELS.GC, (_e, a) => git(a));\n',
          { extra: channels },
        ),
        ELECTRON,
      );
      assert.equal(result.result.status, 2, result.result.stderr);
      const found = finding(result, "RW-E01");
      assert.equal(
        found.title,
        'Renderer can reach process execution via "notes:sync"',
      );
      assert.match(
        found.summary,
        /cannot tell whether that runs a program the v1\.0\.0 handler ran, since it cannot tell which of the 2 v1\.0\.0 main-process handlers whose channel REA did not resolve served it/,
      );
      assert.match(
        found.evidence.map((item) => item.claim).join("\n"),
        /Of the 2 v1\.0\.0 main-process handlers whose channel REA did not resolve, Release Watch connected 1 to execFile\(\) running \/usr\/bin\/git, 1 to no such site/,
      );
    });
  },
);

describe(
  "compare: kept APIs that reach a site whose command REA did not resolve",
  { skip },
  () => {
    it("does not take two sites whose command REA did not resolve for one program", () => {
      const old = syncApp('ipcMain.handle("notes:sync", (_e, a) => run(a));\n');
      // The handler and its site are unchanged; lines moved in lib/run.js.
      const moved = compare(
        old,
        syncApp('ipcMain.handle("notes:sync", (_e, a) => run(a));\n', {
          run: `exports.version = "1.1.0";\n${RUN_ANY}`,
        }),
        ELECTRON,
      );
      assert.equal(moved.result.status, 0, moved.result.stderr);
      assert.deepEqual(
        deskFindings(moved).filter(([rule]) => rule === "RW-E01"),
        [],
      );
      const other = compare(
        old,
        syncApp(
          'ipcMain.handle("notes:sync", (_e, a) => runAny(a[0], a.slice(1)));\n',
        ),
        ELECTRON,
      );
      assert.equal(other.result.status, 2, other.result.stderr);
      const found = finding(other, "RW-E01");
      assert.equal(
        found.title,
        'Renderer can reach process execution via "notes:sync"',
      );
      assert.match(
        found.summary,
        /cannot tell whether that runs a program the v1\.0\.0 handler ran, since REA did not resolve this site's command/,
      );
      assert.ok(
        found.unknowns.some((unknown) =>
          /may be a program the handler already ran/.test(unknown),
        ),
        JSON.stringify(found.unknowns),
      );
    });
  },
);

describe("compare: how RW-E01 words a reach", { skip }, () => {
  const HANDLERS =
    'const handlers = {\n  status: async () => ({ ok: true }),\n  deploy: async () => execFile("/usr/local/bin/deploy", ["--prod"]).pid,\n};\nif (process.argv.includes("--deploy")) handlers.deploy();\nfunction openLog() { return execFile("/usr/bin/xdg-open", ["/var/log/app.log"]); }\nif (process.argv.includes("--log")) openLog();\n';
  const STATUS = ', status: () => ipcRenderer.invoke("app:status")';

  it("cites a settled path when one reaches a site of the group", () => {
    const result = compare(
      desktop(HANDLERS),
      desktop(
        `${HANDLERS}ipcMain.handle("app:status", async () => { openLog(); return handlers.status(); });\n`,
        STATUS,
      ),
      ELECTRON,
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    const found = finding(result, "RW-E01");
    assert.match(found.summary, /its handler reaches execFile\(\)/);
    assert.match(claims(found), /calls openLog through a call REA resolved/);
    assert.ok(
      !found.unknowns.some((unknown) => /may not reach/.test(unknown)),
      JSON.stringify(found.unknowns),
    );
  });

  it("hedges the title and why of a reach that rests on a guess", () => {
    const result = compare(
      desktop(HANDLERS),
      desktop(
        `${HANDLERS}ipcMain.handle("app:status", handlers.status);\n`,
        STATUS,
      ),
      ELECTRON,
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    const found = finding(result, "RW-E01");
    assert.equal(
      found.title,
      'Renderer may reach process execution via "app:status"',
    );
    assert.match(found.summary, /its handler may reach execFile\(\)/);
    assert.match(found.why, /^If the handler does reach it, any script/);
  });
});
