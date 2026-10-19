// Runs the public CLI on one multi-component release pair: new components
// that hold the renderer APIs, process sites, MCP tools and native helper
// another old component had, and an existing component that gains a copy
// of another component's process code. Their claims must name the
// component, not deny what REA saw in the rest of the old release.
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";

import { releases, run, skip } from "./cli-run.mjs";

const written = releases();
after(() => written.cleanup());

const HELPER = "resources/bin/updater";
const CLEANUP =
  'const { spawn } = require("node:child_process");\nexports.cleanup = () => spawn("/usr/bin/notes-cleanup", ["--tmp"]);\n';

// An Electron distribution exposing notes.list and notes.diagnose (which
// reaches execFile), spawning a cleanup process at startup and shipping a
// helper; `extra` adds renderer APIs.
const desk = (name, extra = "") => ({
  [`${name}/resources/app/package.json`]: JSON.stringify({
    name: "notes-desk",
    main: "main.js",
  }),
  [`${name}/resources/app/preload.js`]: `const { contextBridge, ipcRenderer } = require("electron");\ncontextBridge.exposeInMainWorld("notes", {\n  list: () => ipcRenderer.invoke("notes:list"),\n  diagnose: (command) => ipcRenderer.invoke("diag:run", command),\n${extra}});\n`,
  [`${name}/resources/app/main.js`]:
    'const { app, BrowserWindow, ipcMain } = require("electron");\nconst path = require("node:path");\nconst { runDiag } = require("./lib/diag.js");\nconst { cleanup } = require("./lib/cleanup.js");\nipcMain.handle("notes:list", () => []);\nipcMain.handle("diag:run", (_event, command) => runDiag(command));\napp.whenReady().then(() => {\n  cleanup();\n  const win = new BrowserWindow({ webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true } });\n  win.loadFile("index.html");\n});\n',
  [`${name}/resources/app/lib/diag.js`]:
    'const { execFile } = require("node:child_process");\nexports.runDiag = (command) => execFile("/usr/bin/notes-diag", [command]);\n',
  [`${name}/resources/app/lib/cleanup.js`]: CLEANUP,
  [`${name}/resources/app/index.html`]: "<!doctype html><title>Notes</title>\n",
  [`${name}/${HELPER}`]: "#!/bin/sh\necho update\n",
});

// An MCP server with a git tool that reaches execFile and an echo tool
// registered from another module.
const tools = (name) => ({
  [`${name}/package.json`]: JSON.stringify({
    name: "notes-tools",
    type: "module",
    main: "src/server.js",
  }),
  [`${name}/src/server.js`]:
    'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nimport { runGit } from "./git.js";\nimport { registerEcho } from "./echo.js";\nconst server = new McpServer({ name: "notes", version: "1.0.0" });\nserver.registerTool("git_status", {}, async () => ({ content: [{ type: "text", text: await runGit(["status"]) }] }));\nregisterEcho(server);\n',
  [`${name}/src/git.js`]:
    'import { execFile } from "node:child_process";\nexport const runGit = (args) => new Promise((resolve) => execFile("/usr/bin/git", args, (_error, stdout) => resolve(stdout)));\n',
  [`${name}/src/echo.js`]:
    'export const registerEcho = (server) => {\n  server.registerTool("echo", {}, async ({ text }) => ({ content: [{ type: "text", text }] }));\n};\n',
});

const shell = (gained) => ({
  "shell/package.json": JSON.stringify({
    name: "notes-shell",
    main: "index.js",
  }),
  "shell/index.js": gained
    ? 'const { cleanup } = require("./lib/cleanup.js");\ncleanup();\n'
    : 'console.log("shell");\n',
  ...(gained ? { "shell/lib/cleanup.js": CLEANUP } : {}),
});

const release = (version, names, files) => {
  const dir = written.write(version, {
    "release-watch.json": JSON.stringify({
      product: "Notes",
      version,
      components: names.map((name) => ({ name, path: name })),
    }),
    ...files,
  });
  for (const name of names.filter((item) => item.startsWith("desk")))
    chmodSync(path.join(dir, name, HELPER), 0o755);
  return dir;
};

const ANOTHER = "another component of v1\\.0\\.0";
const SHARED =
  /may be the same one, moved from or shared with another component/;

// The release pair is compared once, by the first test that needs it.
let compared = null;
const report = () => {
  if (compared !== null) return compared.report;
  compared = run(
    release("1.0.0", ["desk", "tools", "shell"], {
      ...desk("desk"),
      ...tools("tools"),
      ...shell(false),
    }),
    release("1.1.0", ["desk", "desk2", "tools", "tools2", "shell"], {
      ...desk("desk"),
      ...desk(
        "desk2",
        '  exportAll: () => ipcRenderer.invoke("notes:export"),\n',
      ),
      ...tools("tools"),
      ...tools("tools2"),
      ...shell(true),
    }),
  );
  written.keep(compared.out);
  assert.equal(compared.result.status, 2, compared.result.stderr);
  return compared.report;
};
const finding = (rule, component) => {
  const found = report().findings.find(
    (item) => item.rule === rule && item.component === component,
  );
  assert.ok(found, `${rule} [${component}]`);
  return found;
};
const claims = (item) => item.evidence.map((line) => line.claim);

describe(
  "compare: what a new component holds that another old component had",
  { skip },
  () => {
    it("names the component for renderer APIs and the exec site they reach", () => {
      const reach = finding("RW-E01", "desk2");
      assert.equal(reach.severity, "critical");
      const text = claims(reach).join("\n");
      assert.doesNotMatch(text, /(not observed in|absent from) v1\.0\.0/);
      assert.match(
        text,
        new RegExp(
          `notes\\.diagnose invokes IPC channel "diag:run" \\(component desk2 is new; ${ANOTHER} exposed an API of this name\\)`,
        ),
      );
      assert.match(
        text,
        new RegExp(
          `execFile\\(\\) creates a child process in lib/diag\\.js \\(component desk2 is new; ${ANOTHER} called execFile\\(\\) in a module at this path and shipped this file\\)`,
        ),
      );
      assert.ok(reach.unknowns.some((unknown) => SHARED.test(unknown)));
      // An API no old component exposed keeps the plain absence claim.
      const listed = claims(finding("RW-E04", "desk2"));
      assert.ok(
        listed.some((claim) =>
          new RegExp(
            `^notes\\.list invokes "notes:list" \\(component desk2 is new; ${ANOTHER} exposed`,
          ).test(claim),
        ),
        listed.join("\n"),
      );
      assert.ok(
        listed.some((claim) =>
          /^notes\.exportAll invokes "notes:export" \((absent from|not observed in) v1\.0\.0/.test(
            claim,
          ),
        ),
        listed.join("\n"),
      );
    });

    it("names the component for process sites, new or existing", () => {
      const fresh = finding("RW-P01", "desk2");
      assert.match(
        fresh.summary,
        new RegExp(
          `lib/cleanup\\.js \\(component desk2 is new; ${ANOTHER} called spawn\\(\\) in a module at this path and shipped this file\\)`,
        ),
      );
      assert.ok(fresh.unknowns.some((unknown) => SHARED.test(unknown)));
      const copied = finding("RW-P01", "shell");
      assert.equal(copied.severity, "high");
      // Another component had a site at this path and shipped the file.
      assert.match(
        copied.summary,
        new RegExp(
          `lib/cleanup\\.js \\((absent from|not observed in) component shell of v1\\.0\\.0; ${ANOTHER} called spawn\\(\\) in a module at this path and shipped this file\\)`,
        ),
      );
      assert.doesNotMatch(copied.summary, /a file new in this release/);
    });

    it("names the component for MCP tools and their registrations", () => {
      const tool = finding("RW-M01", "tools2");
      assert.match(
        claims(tool).join("\n"),
        new RegExp(
          `execFile\\(\\) creates a child process \\(component tools2 is new; ${ANOTHER} called execFile\\(\\) in a module at this path and shipped this file\\)`,
        ),
      );
      const registrations = finding("RW-M02", "tools2");
      assert.equal(
        registrations.summary,
        "Component tools2 is new in v1.1.0 and makes 2 tool registration calls, 1 of them in src/echo.js; across the release, v1.0.0 made 2 and v1.1.0 makes 4.",
      );
      assert.match(
        claims(registrations)[0],
        new RegExp(
          `^registerTool\\(\\) call \\(component tools2 is new; ${ANOTHER} made one in a module at this path\\)$`,
        ),
      );
      assert.ok(registrations.unknowns.some((unknown) => SHARED.test(unknown)));
    });

    it("names the component for a helper another component shipped", () => {
      const helper = finding("RW-G04", "desk2");
      assert.equal(
        helper.summary,
        `v1.1.0 ships an executable at ${HELPER} (component desk2 is new; another component of v1.0.0 shipped one at this path).`,
      );
      assert.ok(helper.unknowns.some((unknown) => SHARED.test(unknown)));
    });
  },
);

// A component that gains copies of process code under new paths: one of
// another component's file, one of its own.
const GIT =
  'const { execFile } = require("node:child_process");\nexports.status = () => execFile("/usr/bin/git", ["status", "--short"]);\n';
const PURGE =
  'const { spawn } = require("node:child_process");\nexports.purge = () => spawn("/usr/bin/notes-purge", []);\n';
const copies = (gained) => ({
  "core/package.json": JSON.stringify({ name: "core", main: "src/a.js" }),
  "core/src/a.js": GIT,
  "worker/package.json": JSON.stringify({
    name: "worker",
    main: "src/index.js",
  }),
  "worker/src/index.js": 'require("./purge.js").purge();\n',
  "worker/src/purge.js": PURGE,
  ...(gained
    ? { "worker/src/w.js": GIT, "worker/src/purge-now.js": PURGE }
    : {}),
});

describe(
  "compare: process sites in files the old release shipped elsewhere",
  { skip },
  () => {
    it("says which old side shipped the file instead of denying the site", () => {
      const pair = ["core", "worker"];
      const { result, report } = run(
        release("1.0.0", pair, copies(false)),
        release("1.1.0", pair, copies(true)),
      );
      assert.equal(result.status, 2, result.stderr);
      const summaries = report.findings
        .filter((item) => item.rule === "RW-P01" && item.component === "worker")
        .map((item) => [item.summary, item.unknowns]);
      const of = (file) =>
        summaries.find(([summary]) => summary.includes(file));
      assert.match(
        of("src/w.js")[0],
        new RegExp(
          `src/w\\.js \\((absent from|not observed in) component worker of v1\\.0\\.0; ${ANOTHER} shipped this file\\)\\.$`,
        ),
      );
      assert.ok(of("src/w.js")[1].some((unknown) => SHARED.test(unknown)));
      assert.match(
        of("src/purge-now.js")[0],
        /src\/purge-now\.js \((absent from|not observed in) v1\.0\.0 at this path; v1\.0\.0 shipped this file's content under another path\)\.$/,
      );
      assert.ok(
        of("src/purge-now.js")[1].some((unknown) =>
          /may be a copy of a site v1\.0\.0 had in a file with the same content/.test(
            unknown,
          ),
        ),
      );
    });
  },
);
