// Runs the public CLI on small releases each test writes, for what REA's
// nodes say a member read is read on: a parenthesized expression, in any
// layout, is not `this`, a member of a call's result is not a member of the
// function, and a member read REA's nodes place on no one expression is
// matched to `this` only as a guess.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  claims,
  finding,
  GIT,
  graded,
  MCP,
  SDK,
  server,
  writtenCompare,
} from "./cli-reach-run.mjs";
import { skip } from "./cli-run.mjs";

const compare = writtenCompare();

const unknownMatching = (found, pattern) =>
  found.unknowns.some((unknown) => pattern.test(unknown));

// A class-based CallTool dispatcher whose own run() starts a process that
// no tool calls; `query` is the case the new release adds.
const dbServer = (query) =>
  `import { execFile } from "node:child_process";\nimport { Server } from "@modelcontextprotocol/sdk/server/index.js";\nimport { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";\nimport { connect, replica } from "./db.js";\nexport class DbServer {\n  constructor() {\n    this.server = new Server({ name: "db", version: "1" }, { capabilities: { tools: {} } });\n    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {\n      switch (request.params.name) {\n        case "ping":\n          return { content: [{ type: "text", text: "pong" }] };\n${query ? `        case "query":\n          return { content: [], rows: await ${query} };\n` : ""}        default:\n          throw new Error("unknown tool");\n      }\n    });\n  }\n  run(script) {\n    return execFile("/usr/bin/psql", ["-f", script]);\n  }\n}\n`;
const DB =
  "export const connect = async () => ({ run: async (sql) => ({ rows: [], sql }) });\nexport const replica = { run: async (sql) => ({ rows: [], sql }) };\n";

const dispatch = (query) =>
  compare(
    { "src/index.js": dbServer(null), "src/db.js": DB },
    { "src/index.js": dbServer(query), "src/db.js": DB },
    MCP,
  );

describe("compare: the expression a member call is made on", { skip }, () => {
  for (const receiver of [
    "(await connect())",
    "(replica)",
    "( await connect() )",
    "(\n            await connect()\n          )",
  ])
    it(`does not take ${JSON.stringify(receiver)}.run() for this.run()`, () => {
      const query = `${receiver}.run(request.params.arguments.sql)`;
      const result = dispatch(query);
      assert.equal(result.result.status, 0, result.result.stderr);
      assert.deepEqual(graded(result), []);
    });

  it("follows a member call REA's nodes place on no one expression to this only as a guess", () => {
    const result = dispatch(
      "(request.params.arguments.primary ? replica : connect).run(request.params.arguments.sql)",
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M01", "critical"]]);
    const found = finding(result, "RW-M01");
    assert.match(found.summary, /handler may reach execFile\(\)/);
    assert.match(
      claims(found),
      /reads \.run on an expression REA reports no single receiver for, which may be this, which Release Watch took for run, a function DbServer defines/,
    );
    assert.ok(
      unknownMatching(found, /which expression a member call/),
      JSON.stringify(found.unknowns),
    );
  });
});

const gitIndex = (tool) =>
  `${SDK}import { runGit } from "./git.js";\n${server("1")}server.registerTool("echo", {}, async ({ text }) => ({ content: [{ type: "text", text }] }));\n${tool}export default server;\n`;

describe("compare: a member of a call's result", { skip }, () => {
  it("follows the function called, not a member of it", () => {
    const result = compare(
      { "src/index.js": gitIndex(""), "src/git.js": GIT },
      {
        "src/index.js": gitIndex(
          'server.registerTool("git_log", {}, async ({ ref }) => ({ content: [{ type: "text", text: String(runGit(["log", ref]).pid) }] }));\n',
        ),
        "src/git.js": GIT,
      },
      MCP,
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    const found = finding(result, "RW-M01");
    assert.match(found.summary, /handler reaches execFile\(\)/);
    assert.match(claims(found), /reads runGit, imported from src\/git\.js;/);
    assert.ok(
      !unknownMatching(found, /may not reach/),
      JSON.stringify(found.unknowns),
    );
  });

  it("follows the function called when its result defines a function of the member's name", () => {
    const git =
      'import { execFile } from "node:child_process";\nexport function runGit(args) {\n  const child = execFile("/usr/bin/git", args);\n  return { wait() { return new Promise((done) => child.on("exit", done)); } };\n}\n';
    const result = compare(
      { "src/index.js": gitIndex(""), "src/git.js": git },
      {
        "src/index.js": gitIndex(
          'server.registerTool("git_gc", {}, async () => ({ content: [], code: await runGit(["gc"]).wait() }));\n',
        ),
        "src/git.js": git,
      },
      MCP,
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M01", "critical"]]);
    assert.match(
      finding(result, "RW-M01").summary,
      /handler reaches execFile\(\)/,
    );
  });
});
