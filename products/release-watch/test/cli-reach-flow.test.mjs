// Runs the public CLI on small releases each test writes, for how a tool
// registration or IPC handler reaches process execution through REA's real
// facts: callbacks, `this` dispatch, calls made when a module loads, and
// what a value holds after its declaration.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  claims,
  desktop,
  ECHO_TOOL,
  ELECTRON,
  finding,
  GIT,
  GIT_TOOL,
  graded,
  MCP,
  SDK,
  server,
  SHELL,
  table,
  tableServer,
  writtenCompare,
} from "./cli-reach-run.mjs";
import { skip } from "./cli-run.mjs";

const compare = writtenCompare();

const VALUES = (git) =>
  `import { execFile } from "node:child_process";\n${SDK}${server("1")}const handlers = {\n  echo: async ({ text }) => ({ content: [{ type: "text", text }] }),\n${git ? '  git: async ({ args }) => ({ content: [], out: execFile("/usr/bin/git", args) }),\n' : ""}};\nObject.entries(handlers).forEach(([name, fn]) => server.registerTool(name, {}, fn));\nexport default server;\n`;
const opsServer = (run) =>
  `import { Server } from "@modelcontextprotocol/sdk/server/index.js";\nimport { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";\n${run ? 'import { runShell } from "./shell.js";\n' : ""}class OpsServer {\n  constructor() {\n    this.server = new Server({ name: "ops", version: "1" }, { capabilities: { tools: {} } });\n    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {\n      if (request.params.name === "echo") return this.echo(request.params.arguments);\n${run ? '      if (request.params.name === "run") return this.run(request.params.arguments);\n' : ""}      throw new Error("unknown tool");\n    });\n  }\n  async echo({ text }) {\n    return { content: [{ type: "text", text }] };\n  }\n${run ? "  async run({ command }) {\n    return { content: [], out: runShell(command) };\n  }\n" : ""}}\nexport default new OpsServer();\n`;

describe(
  "compare: tools registered from callbacks and classes",
  { skip },
  () => {
    it("follows a tool table registered from a forEach callback", () => {
      const index = tableServer(
        'server.registerTool("version", {}, async () => ({ content: [{ type: "text", text: "1" }] }));\nTOOLS.forEach((tool) => server.registerTool(tool.name, tool.config, tool.handler));',
      );
      const result = compare(
        {
          "src/index.js": index,
          "src/tools.js": table(ECHO_TOOL),
          "src/git.js": GIT,
        },
        {
          "src/index.js": index,
          "src/tools.js": table(ECHO_TOOL, GIT_TOOL),
          "src/git.js": GIT,
        },
        MCP,
      );
      assert.equal(result.result.status, 2, result.result.stderr);
      assert.deepEqual(graded(result), [["RW-M01", "critical"]]);
      assert.match(
        claims(finding(result, "RW-M01")),
        /reads tool\.handler, a parameter of the callback forEach\(\) runs for each element of its receiver, which reads TOOLS, imported from src\/tools\.js/,
      );
    });

    it("follows the values of a map registered through Object.entries, as a guess", () => {
      const result = compare(
        { "src/index.js": VALUES(false) },
        { "src/index.js": VALUES(true) },
        MCP,
      );
      assert.equal(result.result.status, 2, result.result.stderr);
      assert.deepEqual(graded(result), [["RW-M01", "critical"]]);
      // REA does not say whether `name` or `fn` holds the value.
      const found = finding(result, "RW-M01");
      assert.match(found.summary, /handler may reach execFile\(\)/);
      assert.match(
        claims(found),
        /a parameter of the callback forEach\(\) runs for each element of its receiver; REA does not say whether it holds a whole element, a property of one or a key/,
      );
      assert.ok(
        found.unknowns.some((unknown) =>
          /which part of each element a callback parameter holds/.test(unknown),
        ),
        JSON.stringify(found.unknowns),
      );
    });

    it("follows this.run() in a class-based CallTool dispatcher", () => {
      const result = compare(
        { "src/index.js": opsServer(false), "src/shell.js": SHELL },
        { "src/index.js": opsServer(true), "src/shell.js": SHELL },
        MCP,
      );
      assert.equal(result.result.status, 2, result.result.stderr);
      assert.deepEqual(graded(result), [["RW-M01", "critical"]]);
      const found = finding(result, "RW-M01");
      assert.match(
        claims(found),
        /reads \.run on a receiver REA does not resolve \(such as this\), which Release Watch took for run, a function OpsServer defines, which reads runShell, imported from src\/shell\.js/,
      );
      assert.ok(
        found.unknowns.some((unknown) => /this\.run\(\)/.test(unknown)),
        JSON.stringify(found.unknowns),
      );
    });
  },
);

describe("compare: what an IPC handler's value reaches", { skip }, () => {
  it("does not take a listener registered after a handler map for part of it", () => {
    const quit = 'app.on("before-quit", () => execFile("/usr/bin/sync"));\n';
    const result = compare(
      desktop(quit),
      desktop(
        `const handlers = { version: () => app.getVersion() };\n${quit}ipcMain.handle("invoke", (event, name) => handlers[name]());\n`,
        ', invoke: (name) => ipcRenderer.invoke("invoke", name)',
      ),
      ELECTRON,
    );
    assert.equal(result.result.status, 0, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-E04", "low"]]);
  });

  it("says when it cannot tell which function of a handler map a handler calls", () => {
    const result = compare(
      desktop(""),
      desktop(
        'const handlers = {\n  version: () => app.getVersion(),\n  uptime() { return process.uptime(); },\n  openLogs: () => execFile("xdg-open", [app.getPath("logs")]),\n};\nipcMain.handle("app:version", () => handlers.version());\n',
        ', version: () => ipcRenderer.invoke("app:version")',
      ),
      ELECTRON,
    );
    const found = finding(result, "RW-E01");
    assert.match(found.summary, /its handler may reach execFile\(\)/);
    assert.match(
      claims(found),
      /reads handlers\.version; REA names no function version in the initializer of handlers, so Release Watch followed each function it defines/,
    );
  });

  it("does not take a method REA names after another member for the member a handler reads", () => {
    const result = compare(
      desktop(""),
      desktop(
        'const handlers = {\n  version: () => app.getVersion(),\n  openLogs() { return execFile("xdg-open", [app.getPath("logs")]); },\n};\nipcMain.handle("app:version", () => handlers.version());\n',
        ', version: () => ipcRenderer.invoke("app:version")',
      ),
      ELECTRON,
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    assert.deepEqual(graded(result), [
      ["RW-P01", "high"],
      ["RW-E04", "low"],
    ]);
  });

  it("does not count a call an initializer makes when the module loads as the handler's", () => {
    const result = compare(
      desktop(""),
      desktop(
        'function gitVersion() { return execFile("git", ["--version"]).pid; }\nconst about = { git: gitVersion(), node: process.versions.node };\nipcMain.handle("app:about", () => about);\n',
        ', about: () => ipcRenderer.invoke("app:about")',
      ),
      ELECTRON,
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    assert.deepEqual(graded(result), [
      ["RW-P01", "high"],
      ["RW-E04", "low"],
    ]);
  });
});

const writtenMap = (git) =>
  `import { execFile } from "node:child_process";\n${SDK}${server("1")}server.onerror = () => execFile("/usr/bin/pkill", ["-f", "ops-helper"]);\nconst handlers = {};\nhandlers.status = async () => ({ content: [{ type: "text", text: "ok" }] });\nhandlers.deploy = async () => execFile("/usr/local/bin/deploy", ["--prod"]);\nhandlers.git = async ({ args }) => ({ content: [], out: execFile("/usr/bin/git", args) });\nif (process.argv[2] === "deploy") handlers.deploy();\nserver.registerTool("status", {}, handlers.status);\n${git ? 'server.registerTool("git", {}, handlers.git);\n' : ""}export default server;\n`;
const dispatcher = (sh) =>
  `import { execFile } from "node:child_process";\nimport { Server } from "@modelcontextprotocol/sdk/server/index.js";\nimport { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";\nconst server = new Server({ name: "ops", version: "1" }, { capabilities: { tools: {} } });\nconst tools = new Map();\ntools.set("echo", async ({ text }) => ({ content: [{ type: "text", text }] }));\n${sh ? 'tools.set("sh", async ({ cmd }) => ({ content: [], out: execFile("/bin/sh", ["-c", cmd]) }));\n' : ""}server.setRequestHandler(CallToolRequestSchema, async (request) => tools.get(request.params.name)(request.params.arguments));\nexport default server;\n`;
const TIME_TOOL =
  '{ name: "time", handler: async () => ({ content: [{ type: "text", text: new Date().toISOString() }] }) }';
const GIT_ENTRY =
  '{ name: "git", handler: async ({ args }) => ({ content: [], out: execFile("/usr/bin/git", args) }) }';
const extended = (added) =>
  `import { execFile } from "node:child_process";\n${SDK}${server("1")}function loadTools() {\n  return [{ name: "echo", handler: async ({ text }) => ({ content: [{ type: "text", text }] }) }];\n}\nlet TOOLS = loadTools();\nTOOLS.push(${TIME_TOOL});\n${added}for (const tool of TOOLS) server.registerTool(tool.name, {}, tool.handler);\nexport default server;\n`;

describe("compare: what a value holds after its declaration", { skip }, () => {
  it("selects the function REA reports written to the member read, and no other member's", () => {
    const result = compare(
      { "src/index.js": writtenMap(false) },
      { "src/index.js": writtenMap(true) },
      MCP,
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M01", "critical"]]);
    const found = finding(result, "RW-M01");
    assert.match(found.summary, /whose handler reaches execFile\(\)/);
    assert.equal(
      claims(found),
      `${claims({ evidence: found.evidence.slice(0, 1) })}\nThe registration call reads handlers.git, a property REA reports written with a function; execFile() runs there. REA reports each read, import and function; Release Watch connects them`,
    );
  });

  it("follows the handlers a CallTool dispatcher looks up in a map filled by set()", () => {
    const result = compare(
      { "src/index.js": dispatcher(false) },
      { "src/index.js": dispatcher(true) },
      MCP,
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M01", "critical"]]);
    assert.match(
      claims(finding(result, "RW-M01")),
      /reads tools\.get, whose initializer or later assignments define a function; execFile\(\) runs there/,
    );
  });

  it("follows a function stored through a computed property", () => {
    const head = `import { execFile } from "node:child_process";\n${SDK}${server("1")}const key = process.env.TOOL ?? "git";\nconst handlers = { echo: async () => ({ content: [] }) };\n`;
    const echo = 'server.registerTool("echo", {}, handlers.echo);\n';
    const result = compare(
      { "src/index.js": `${head}${echo}export default server;\n` },
      {
        "src/index.js": `${head}handlers[key] = async ({ args }) => ({ content: [], out: execFile("/usr/bin/git", args) });\n${echo}server.registerTool(key, {}, handlers[key]);\nexport default server;\n`,
      },
      MCP,
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M01", "critical"]]);
    assert.match(
      claims(finding(result, "RW-M01")),
      /reads handlers, whose initializer or later assignments define a function; execFile\(\) runs there/,
    );
  });

  it("follows elements push() adds to a table", () => {
    const result = compare(
      { "src/index.js": extended("") },
      { "src/index.js": extended(`TOOLS.push(${GIT_ENTRY});\n`) },
      MCP,
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M01", "critical"]]);
  });

  it("ends a table at a property write that follows it", () => {
    const head = `import { execFile } from "node:child_process";\n${SDK}${server("1")}const TOOLS = [{ name: "echo", handler: async ({ text }) => ({ content: [{ type: "text", text }] }) }];\nserver.onerror = () => execFile("/usr/bin/pkill", ["-f", "ops-helper"]);\nfor (const tool of TOOLS) server.registerTool(tool.name, {}, tool.handler);\n`;
    const result = compare(
      { "src/index.js": head },
      {
        "src/index.js": `${head}server.registerTool("ping", {}, TOOLS[0].handler);\n`,
      },
      MCP,
    );
    assert.equal(result.result.status, 0, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M02", "medium"]]);
  });

  it("follows a later assignment that extends a table a call initialized", () => {
    const result = compare(
      { "src/index.js": extended("") },
      {
        "src/index.js": extended(
          `if (process.env.OPS) TOOLS = [...TOOLS, ${GIT_ENTRY}];\n`,
        ),
      },
      MCP,
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M01", "critical"]]);
    assert.match(
      claims(finding(result, "RW-M01")),
      /initializer or later assignments of TOOLS/,
    );
  });
});
