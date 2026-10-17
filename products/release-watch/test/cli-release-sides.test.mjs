// Runs the public CLI on multi-component releases each test writes, for
// sides REA has no application facts for (one REA could not analyze, one
// that holds nothing REA can analyze, one given as a capture only), the
// deployment hosts one component's capture shows, and the names and
// Evidence files of a renamed component.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";

import { releases, run, skip } from "./cli-run.mjs";

const written = releases();
after(() => written.cleanup());

// A release whose manifest lists `components` (`{ name, path, capture }`).
const release = (version, components, files) =>
  written.write(version, {
    "release-watch.json": JSON.stringify({
      product: "Suite",
      version,
      components,
    }),
    ...files,
  });

const compare = (before, after) => {
  const result = run(release("1.0.0", ...before), release("1.1.0", ...after));
  written.keep(result.out);
  return result;
};

const graded = (report) =>
  report.findings.map((finding) => [
    finding.rule,
    finding.severity,
    finding.component,
  ]);

const ofRule = (report, rule) =>
  report.findings.filter((finding) => finding.rule === rule);

const claims = (finding) => finding.evidence.map((item) => item.claim);

const pkg = (name, main) =>
  JSON.stringify({ name, version: "1.0.0", type: "module", main });

// An MCP server whose tool runs git through a helper module.
const MCP_TOOLS = {
  "src/server.js":
    'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nimport { runGit } from "./git.js";\nconst server = new McpServer({ name: "acme", version: "1.0.0" });\nserver.registerTool("git_status", {}, async () => ({ content: [{ type: "text", text: await runGit(["status"]) }] }));\n',
  "src/git.js":
    'import { execFile } from "node:child_process";\nexport const runGit = (args) => new Promise((resolve) => execFile("/usr/bin/git", args, (_e, out) => resolve(out)));\n',
};

const under = (directory, files) =>
  Object.fromEntries(
    Object.entries(files).map(([file, text]) => [`${directory}/${file}`, text]),
  );

// One HAR entry: a GET of `url` answered with HTML, redirecting to `to`.
const entry = (url, to = null) => ({
  pageref: "page_1",
  startedDateTime: "2026-10-15T10:00:00.010Z",
  time: 10,
  request: {
    method: "GET",
    url,
    httpVersion: "HTTP/1.1",
    cookies: [],
    headers: [{ name: "Host", value: new URL(url).host }],
    queryString: [],
    headersSize: -1,
    bodySize: 0,
  },
  response: {
    status: to === null ? 200 : 302,
    statusText: to === null ? "OK" : "Found",
    httpVersion: "HTTP/1.1",
    cookies: [],
    headers: [
      { name: "content-type", value: "text/html" },
      ...(to === null ? [] : [{ name: "location", value: to }]),
    ],
    content: { size: 10, mimeType: "text/html" },
    redirectURL: to ?? "",
    headersSize: -1,
    bodySize: 10,
  },
  cache: {},
  timings: { send: 0, wait: 1, receive: 1 },
});

// A capture of one page load from `host`, redirected through a sign-in at
// `via` and back first when it is given.
const har = (host, { via = null } = {}) =>
  JSON.stringify({
    log: {
      version: "1.2",
      creator: { name: "test", version: "1" },
      pages: [
        {
          startedDateTime: "2026-10-15T10:00:00.000Z",
          id: "page_1",
          title: host,
          pageTimings: {},
        },
      ],
      entries:
        via === null
          ? [entry(`https://${host}/`)]
          : [
              entry(`https://${host}/`, `https://${via}/authorize`),
              entry(`https://${via}/authorize`, `https://${host}/callback`),
              entry(`https://${host}/callback`),
            ],
    },
  });

describe(
  "compare: a component whose new side REA has no facts for",
  { skip },
  () => {
    it("keeps its old sites and tools, so a copy elsewhere is new", () => {
      const { result, report } = compare(
        [
          [{ name: "tools", path: "tools" }],
          {
            "tools/package.json": pkg("acme-tools", "src/server.js"),
            ...under("tools", MCP_TOOLS),
          },
        ],
        [
          [
            { name: "tools", path: "tools" },
            { name: "tools2", path: "tools2" },
          ],
          {
            // No package.json: nothing REA can analyze.
            ...under("tools", MCP_TOOLS),
            "tools2/package.json": pkg("acme-tools", "src/server.js"),
            ...under("tools2", MCP_TOOLS),
          },
        ],
      );
      assert.equal(result.status, 2, result.stderr);
      assert.deepEqual(graded(report), [
        ["RW-M01", "critical", "tools2"],
        ["RW-C02", "low", "tools"],
        ["RW-C02", "low", "tools2"],
      ]);
      assert.deepEqual(
        report.errors.map((error) => [error.component, error.side, error.code]),
        [["tools", "right", "no_analyzable_target"]],
      );
      const [coverage] = ofRule(report, "RW-C02");
      assert.equal(
        coverage.summary,
        "v1.1.0 holds nothing REA can analyze for component tools, so v1.0.0's application code in it was compared with nothing; what that code did is unknown now, not gone.",
      );
    });

    it("keeps the old sites of a component given as a capture only, and says its code was not compared", () => {
      const ls =
        'const { exec } = require("node:child_process");\nexec("ls -la");\n';
      const { result, report } = compare(
        [
          [
            { name: "web", path: "web/site", capture: "web.har" },
            { name: "api", path: "api" },
          ],
          {
            "web.har": har("notes.acme.test"),
            "web/site/index.html":
              '<!doctype html><script src="app.js"></script>\n',
            "web/site/app.js": ls,
            "api/package.json": JSON.stringify({ name: "api", main: "a.js" }),
            "api/a.js": 'require("node:http").createServer().listen(8080);\n',
          },
        ],
        [
          [
            { name: "web", path: "web.har" },
            { name: "api", path: "api" },
          ],
          {
            "web.har": har("notes.acme.test"),
            "api/package.json": JSON.stringify({ name: "api", main: "a.js" }),
            "api/a.js": `require("node:http").createServer().listen(8080);\n${ls}`,
          },
        ],
      );
      assert.equal(result.status, 2, result.stderr);
      assert.deepEqual(graded(report), [
        ["RW-P01", "high", "api"],
        ["RW-C02", "low", "web"],
      ]);
      assert.match(
        ofRule(report, "RW-C02")[0].summary,
        /^v1\.1\.0 gives only a capture for component web, so v1\.0\.0's application code in it was compared with nothing/,
      );
    });
  },
);

describe(
  "compare: a component whose old side holds no application facts",
  { skip },
  () => {
    const main =
      'const { app, BrowserWindow } = require("electron");\napp.whenReady().then(() => {\n  const win = new BrowserWindow({ webPreferences: { contextIsolation: false, sandbox: false, nodeIntegration: true } });\n  win.loadURL("https://app.thirdparty.example/");\n});\n';
    const desk = {
      "desk/package.json": JSON.stringify({ name: "desk", main: "main.js" }),
      "desk/main.js": main,
    };

    it("grades it on coverage only when nothing there can be analyzed, like an old side REA failed on, windows included", () => {
      const { result, report } = compare(
        [[{ name: "desk", path: "desk" }], { "desk/main.js": main }],
        [[{ name: "desk", path: "desk" }], desk],
      );
      assert.equal(result.status, 1, result.stderr);
      assert.equal(report.verdict.decision, "error");
      assert.deepEqual(graded(report), [["RW-C02", "low", "desk"]]);
      assert.match(
        report.findings[0].summary,
        /^v1\.0\.0 holds nothing REA can analyze for component desk, so v1\.1\.0's application code in it was compared with nothing and only coverage was graded\.$/,
      );
    });

    it("judges new windows on their own values, as the other rules judge that side, when the old side is a capture only", () => {
      const { report } = compare(
        [
          [{ name: "desk", path: "desk.har" }],
          { "desk.har": har("app.thirdparty.example") },
        ],
        [
          [{ name: "desk", path: "desk", capture: "desk.har" }],
          {
            ...desk,
            "desk.har": har("app.thirdparty.example"),
          },
        ],
      );
      assert.deepEqual(
        ofRule(report, "RW-E02").map((finding) => finding.title),
        [
          "New BrowserWindow without the renderer sandbox (sandbox: false)",
          "New BrowserWindow without context isolation (contextIsolation: false)",
          "New BrowserWindow with Node.js integration in the renderer (nodeIntegration: true)",
        ],
      );
      assert.match(
        ofRule(report, "RW-C02")[0].summary,
        /^v1\.0\.0 gives only a capture for component desk, so v1\.1\.0's application code in it was compared with nothing; what it has is reported as not observed before\.$/,
      );
    });
  },
);

describe(
  "compare: claims about an old release with a component REA could not analyze",
  { skip },
  () => {
    const desk = (sync) => ({
      "desk/package.json": JSON.stringify({ name: "desk", main: "main.js" }),
      "desk/index.html": "<!doctype html><title>Notes</title>\n",
      "desk/main.js":
        'const { app, BrowserWindow, ipcMain } = require("electron");\nconst path = require("node:path");\nipcMain.handle("notes:list", () => []);\napp.whenReady().then(() => {\n  const win = new BrowserWindow({ webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true } });\n  win.loadFile("index.html");\n});\n',
      "desk/preload.js": `const { contextBridge, ipcRenderer } = require("electron");\ncontextBridge.exposeInMainWorld("notes", {\n  list: () => ipcRenderer.invoke("notes:list"),\n${sync ? '  sync: () => ipcRenderer.invoke("notes:sync"),\n' : ""}});\n`,
    });
    const legacy = { name: "legacy", path: "legacy.asar" };
    const corrupt = { "legacy.asar": "not an asar\u0000garbage" };

    it("names the unanalyzed component instead of saying the old release lacked a renderer API", () => {
      const { report } = compare(
        [
          [{ name: "desk", path: "desk" }, legacy],
          { ...desk(false), ...corrupt },
        ],
        [
          [{ name: "desk", path: "desk" }, legacy],
          { ...desk(true), ...corrupt },
        ],
      );
      const [api] = ofRule(report, "RW-E04");
      assert.deepEqual(claims(api), [
        'notes.sync invokes "notes:sync" (absent from component desk of v1.0.0; REA did not analyze the code of component legacy of v1.0.0, which may have had it)',
      ]);
    });

    it("names it where the old release is said to lack an SDK, a package or original sources", () => {
      const now = desk(false);
      const { report } = compare(
        [
          [{ name: "desk", path: "desk" }, legacy],
          { ...desk(false), ...corrupt },
        ],
        [
          [{ name: "desk", path: "desk" }, legacy],
          {
            ...now,
            "desk/main.js": `${now["desk/main.js"]}const OpenAI = require("openai");\nconst pad = require("left-pad");\n`,
            "desk/index.html":
              '<!doctype html><title>Notes</title><script src="renderer.js"></script>\n',
            "desk/renderer.js":
              'console.log("render");\n//# sourceMappingURL=renderer.js.map\n',
            "desk/renderer.js.map": JSON.stringify({
              version: 3,
              file: "renderer.js",
              sources: ["../src/renderer.ts"],
              sourcesContent: ['console.log("render");\n'],
              names: [],
              mappings: "AAAA",
            }),
            ...corrupt,
          },
        ],
      );
      const unknown =
        "REA did not analyze the code of component legacy of v1.0.0, which may have";
      assert.deepEqual(
        [
          ...claims(ofRule(report, "RW-A03")[0]),
          ...claims(ofRule(report, "RW-W03")[0]),
          ofRule(report, "RW-D01")[0].summary,
        ],
        [
          `main.js imports openai (absent from component desk of v1.0.0; ${unknown} had it)`,
          `../src/renderer.ts (absent from component desk of v1.0.0; ${unknown} had it)`,
          `v1.1.0 imports 1 package that no analyzed module of the old release imported; ${unknown}.`,
        ],
      );
    });

    it("names it where a new host was not seen in the old release", () => {
      const now = desk(false);
      const { report } = compare(
        [
          [{ name: "desk", path: "desk" }, legacy],
          { ...desk(false), ...corrupt },
        ],
        [
          [{ name: "desk", path: "desk" }, legacy],
          {
            ...now,
            "desk/main.js": `${now["desk/main.js"]}fetch("https://telemetry.thirdparty.example/v1/events", { method: "POST" });\n`,
            ...corrupt,
          },
        ],
      );
      const [host] = ofRule(report, "RW-N01");
      assert.ok(
        host.unknowns.includes(
          "REA did not analyze the code of component legacy of v1.0.0, so it may have contacted this host.",
        ),
        JSON.stringify(host.unknowns),
      );
    });

    it("says which component the release's registration totals leave out", () => {
      const server = (tools) =>
        `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nconst server = new McpServer({ name: "s", version: "1.0.0" });\n${tools.map((tool) => `server.registerTool("${tool}", {}, async () => ({ content: [] }));\n`).join("")}`;
      const { report } = compare(
        [
          [{ name: "legacy", path: "legacy" }],
          {
            "legacy/package.json": pkg("legacy", "src/server.js"),
            "legacy/src/server.js": server(["echo", "time"]),
          },
        ],
        [
          [legacy, { name: "agent", path: "agent" }],
          {
            ...corrupt,
            "agent/package.json": pkg("agent", "src/server.js"),
            "agent/src/server.js": server(["ask"]),
          },
        ],
      );
      const [registrations] = ofRule(report, "RW-M02");
      assert.equal(
        registrations.summary,
        "Component agent is new in v1.1.0 and makes 1 tool registration call, in src/server.js; across the release except component legacy, whose code REA did not analyze in v1.1.0, v1.0.0 made 0 and v1.1.0 makes 1.",
      );
    });
  },
);

describe(
  "compare: the deployment one component's capture shows",
  { skip },
  () => {
    it("is the site itself for every component, while a third party stays new", () => {
      const api = (host) => ({
        "api/package.json": JSON.stringify({ name: "api", main: "server.js" }),
        "api/server.js": `const BASE = "https://${host}";\nexport const refresh = () => fetch(BASE + "/hooks/refresh", { method: "POST" });\n${host === "app.acmecloud.test" ? 'export const report = () => fetch("https://collector.thirdparty.test/v1", { method: "POST" });\n' : ""}`,
      });
      const web = (host) => ({
        "web.har": har(host),
        "web/site/index.html":
          '<!doctype html><script src="app.js"></script>\n',
        "web/site/app.js": `fetch("https://${host}/api/notes");\n`,
      });
      const components = [
        { name: "web", path: "web/site", capture: "web.har" },
        { name: "api", path: "api" },
      ];
      const { result, report } = compare(
        [
          components,
          { ...web("notes.acmecloud.test"), ...api("notes.acmecloud.test") },
        ],
        [
          components,
          { ...web("app.acmecloud.test"), ...api("app.acmecloud.test") },
        ],
      );
      assert.equal(result.status, 2, result.stderr);
      assert.deepEqual(
        ofRule(report, "RW-N01").map((finding) => [
          finding.component,
          finding.title,
        ]),
        [["api", "New third-party destination: collector.thirdparty.test"]],
      );
    });

    // The session's first page load redirects through another party's
    // sign-in and back: that host is not where the release is deployed.
    it("is not a sign-in host the capture was redirected through", () => {
      const files = (host, via, destination) => ({
        "web.har": har(host, { via }),
        "web/site/index.html":
          '<!doctype html><script src="app.js"></script>\n',
        "web/site/app.js": `fetch("https://${host}/api/notes");\n`,
        "api/package.json": JSON.stringify({ name: "api", main: "server.js" }),
        "api/server.js": `export const send = (headers) => fetch("https://${destination}/v1/events", { method: "POST", body: JSON.stringify(headers) });\n`,
      });
      const components = [
        { name: "web", path: "web/site", capture: "web.har" },
        { name: "api", path: "api" },
      ];
      const { result, report } = compare(
        [
          components,
          files("notes.acmecloud.test", null, "notes.acmecloud.test"),
        ],
        [
          components,
          files(
            "app.acmecloud.test",
            "login.idp-vendor.test",
            "login.idp-vendor.test",
          ),
        ],
      );
      assert.equal(result.status, 2, result.stderr);
      assert.deepEqual(
        ofRule(report, "RW-N01").map((finding) => [
          finding.component,
          finding.severity,
          finding.title,
        ]),
        [["api", "high", "New third-party destination: login.idp-vendor.test"]],
      );
    });
  },
);

describe("compare: a renamed component", { skip }, () => {
  // Shares its page and preload with the other side, so pairs as renamed.
  const desk = (runner) => ({
    "package.json": JSON.stringify({ name: "desk", main: "main.js" }),
    "about.html": "<!doctype html><title>About</title>\n",
    "preload.js":
      'const { contextBridge } = require("electron");\ncontextBridge.exposeInMainWorld("notes", {});\n',
    "main.js": `const { ipcMain } = require("electron");\nconst { run } = require("./lib/${runner}");\nipcMain.handle("diag:run", (_e, c) => run("/usr/bin/notes-diag", [c]));\n`,
    [`lib/${runner}`]:
      'const { execFile } = require("node:child_process");\nexports.run = (cmd, args) => execFile(cmd, args);\n',
  });

  it("never shares a name or Evidence files with a manifest component", () => {
    const { out, result, report } = compare(
      [[{ name: "desk", path: "desk" }], under("desk", desk("run.js"))],
      [
        [
          { name: "desktop", path: "desktop" },
          { name: "desk-to-desktop", path: "other" },
        ],
        {
          ...under("desktop", desk("runner.js")),
          "other/package.json": JSON.stringify({ name: "o", main: "i.js" }),
          "other/i.js": 'console.log("other");\n',
        },
      ],
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(graded(report), [["RW-C02", "low", "desk-to-desktop"]]);
    const [renamed, other] = report.components;
    assert.deepEqual(
      [renamed.name, other.name, renamed.module_aliases.map((a) => a.to)],
      ["desk → desktop", "desk-to-desktop", ["lib/runner.js"]],
    );
    // Every cited Evidence file holds the Evidence it is cited for.
    for (const side of report.components.flatMap((c) => [c.left, c.right]))
      if (side.application) {
        const saved = JSON.parse(
          readFileSync(path.join(out, side.application.evidence_file), "utf8"),
        );
        assert.equal(saved.evidence_id, side.application.evidence_id);
      }
  });

  it("names the old component in claims about the old release", () => {
    const cleanup =
      'const { spawn } = require("node:child_process");\nexports.cleanup = () => spawn("/usr/bin/notes-cleanup", ["--tmp"]);\n';
    const { report } = compare(
      [
        [
          { name: "desk", path: "desk" },
          { name: "api", path: "api" },
        ],
        {
          ...under("desk", desk("run.js")),
          "desk/lib/cleanup.js": cleanup,
          "desk/boot.js": 'require("./lib/cleanup.js").cleanup();\n',
          "api/package.json": JSON.stringify({ name: "api", main: "s.js" }),
          "api/s.js": 'require("node:http").createServer().listen(8080);\n',
        },
      ],
      [
        [
          { name: "desktop", path: "desktop" },
          { name: "api", path: "api" },
        ],
        {
          ...under("desktop", desk("run.js")),
          "api/package.json": JSON.stringify({ name: "api", main: "s.js" }),
          "api/s.js": 'require("./lib/cleanup.js").cleanup();\n',
          "api/lib/cleanup.js": cleanup,
        },
      ],
    );
    const [moved] = ofRule(report, "RW-P01");
    const old = moved.evidence.find((item) => item.side === "left");
    assert.equal(moved.severity, "low");
    assert.equal(
      old.claim,
      "v1.0.0, component desk: spawn() with the same command in lib/cleanup.js",
    );
    assert.equal(old.location.component, "desk");
  });
});
