// Runs the public CLI on small releases each test writes, for calls a
// value or handler makes, through REA's real facts: a call read as part of
// a literal, a function an initializer runs in place, a method bound back
// to its receiver, `this.method()` through a base class or a class field,
// and connections that rest on a guess.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  claims,
  desktop,
  ELECTRON,
  finding,
  graded,
  MCP,
  SDK,
  server,
  SHELL,
  writtenCompare,
} from "./cli-reach-run.mjs";
import { skip } from "./cli-run.mjs";

const compare = writtenCompare();

const EXEC = 'import { execFile } from "node:child_process";\n';
const mcpIndex = (body, imports = "") =>
  `${EXEC}${imports}${SDK}${server("1")}${body}export default server;\n`;

const unknownMatching = (found, pattern) =>
  assert.ok(
    found.unknowns.some((unknown) => pattern.test(unknown)),
    JSON.stringify(found.unknowns),
  );

describe("compare: calls an initializer makes", { skip }, () => {
  it("says a handler map may reach only what a call after it is given", () => {
    const watch = 'import { watch } from "node:fs";\n';
    const watcher =
      'watch("/var/lib/notes", () => execFile("/usr/bin/notes-index", ["--rebuild"]));\n';
    const result = compare(
      {
        "src/index.js": mcpIndex(
          `${watcher}server.registerTool("time", {}, async () => ({ content: [] }));\n`,
          watch,
        ),
      },
      {
        "src/index.js": mcpIndex(
          `const handlers = { time: async () => ({ content: [] }) };\n${watcher}server.registerTool("call", {}, async ({ name }) => handlers[name]());\n`,
          watch,
        ),
      },
      MCP,
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M01", "critical"]]);
    const found = finding(result, "RW-M01");
    assert.match(found.summary, /handler may reach execFile\(\)/);
    assert.match(claims(found), /the call may be a statement after it/);
    unknownMatching(
      found,
      /does not report where an object or array literal ends/,
    );
  });

  it("does not count a function an initializer runs in place as the handler's", () => {
    const result = compare(
      desktop(""),
      desktop(
        'function gitVersion() { return execFile("git", ["--version"]).pid; }\nconst about = (() => ({ git: gitVersion(), node: process.versions.node }))();\nipcMain.handle("app:about", () => about);\n',
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

  it("does not follow a receiver a method is bound back to", () => {
    const repo = (registration) =>
      mcpIndex(
        `class Repo {\n  status() { return { content: [{ type: "text", text: "clean" }] }; }\n  gc() { return execFile("/usr/bin/git", ["gc"]); }\n}\nconst repo = new Repo();\nif (process.argv[2] === "gc") repo.gc();\n${registration}`,
      );
    const result = compare(
      { "src/index.js": repo("") },
      {
        "src/index.js": repo(
          'server.registerTool("status", {}, repo.status.bind(repo));\n',
        ),
      },
      MCP,
    );
    assert.equal(result.result.status, 0, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M02", "medium"]]);
  });
});

const HEAD =
  'import { Server } from "@modelcontextprotocol/sdk/server/index.js";\nimport { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";\nimport { runShell } from "./shell.js";\n';
const dispatch = (run, base) =>
  `  constructor() {\n${base ? "    super();\n" : ""}    this.server = new Server({ name: "ops", version: "1" }, { capabilities: { tools: {} } });\n    this.server.setRequestHandler(CallToolRequestSchema, async (request) => ${run ? 'request.params.name === "run" ? this.run(request.params.arguments) : ' : ""}this.echo(request.params.arguments));\n  }\n  echo({ text }) { return { content: [{ type: "text", text }] }; }\n`;
const RUN = "({ command }) { return { content: [], out: runShell(command) }; }";
const SERVERS = {
  inherited: (run) =>
    `${HEAD}class Base { run${RUN} }\nclass OpsServer extends Base {\n${dispatch(run, true)}}\nexport default new OpsServer();\n`,
  field: (run) =>
    `${HEAD}class OpsServer {\n${run ? `  run = async ${RUN.replace(") {", ") => {")};\n` : ""}${dispatch(run, false)}}\nexport default new OpsServer();\n`,
};

describe("compare: this.method() a handler calls", { skip }, () => {
  for (const [kind, expected] of [
    [
      "inherited",
      /reads \.run on a receiver REA does not resolve \(such as this\), which OpsServer does not define; Release Watch looked run up in Base, a binding OpsServer reads outside its methods \(such as the class it extends\), which reads Base\.run, a function Base defines, which reads runShell/,
    ],
    [
      "field",
      /reads \.run on a receiver REA does not resolve \(such as this\), which Release Watch took for the function the class field run of OpsServer holds, which reads runShell/,
    ],
  ])
    it(`follows this.run() to a ${kind === "inherited" ? "method of the class it extends" : "class field"}`, () => {
      const result = compare(
        { "src/index.js": SERVERS[kind](false), "src/shell.js": SHELL },
        { "src/index.js": SERVERS[kind](true), "src/shell.js": SHELL },
        MCP,
      );
      assert.equal(result.result.status, 2, result.result.stderr);
      assert.deepEqual(graded(result), [["RW-M01", "critical"]]);
      const found = finding(result, "RW-M01");
      assert.match(found.summary, /handler reaches exec\(\)/);
      assert.match(claims(found), expected);
      unknownMatching(found, /this\.run\(\)/);
    });
});

describe("compare: connections that rest on a guess", { skip }, () => {
  it("says may reach when only a guessed connection is new", () => {
    const index = (registration) =>
      mcpIndex(
        `const runDeploy = () => execFile("/usr/local/bin/deploy", ["--prod"]);\nconst commands = {\n  status: async () => ({ content: [{ type: "text", text: "ok" }] }),\n  deploy: async () => ({ content: [], pid: runDeploy().pid }),\n};\nserver.registerTool("deploy", {}, async () => ({ content: [], pid: runDeploy().pid }));\nif (process.argv[2] === "deploy") commands.deploy();\n${registration}`,
      );
    const result = compare(
      { "src/index.js": index("") },
      {
        "src/index.js": index(
          'server.registerTool("status", {}, commands.status);\n',
        ),
      },
      MCP,
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M01", "critical"]]);
    assert.match(
      finding(result, "RW-M01").summary,
      /handler may reach execFile\(\)/,
    );
  });

  it("takes a function a shorthand map holds for a candidate, not a container", () => {
    const index = (registration) =>
      mcpIndex(
        `const status = async () => ({ content: [{ type: "text", text: "ok" }] });\nconst deploy = async () => execFile("/usr/local/bin/deploy", ["--prod"]);\nconst commands = { status, deploy };\nif (process.argv[2] === "deploy") commands.deploy();\n${registration}`,
      );
    const result = compare(
      { "src/index.js": index("") },
      {
        "src/index.js": index(
          'server.registerTool("status", {}, commands.status);\n',
        ),
      },
      MCP,
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    const found = finding(result, "RW-M01");
    assert.match(found.summary, /handler may reach execFile\(\)/);
    assert.match(
      claims(found),
      /reads deploy, a function in the same module the value holds that could be status, so Release Watch followed it/,
    );
  });
});
