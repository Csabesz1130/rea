// Runs the public CLI on small MCP servers each test writes, for how a
// tool reaches the methods of a class: constructing it runs its
// constructor, not its other methods; a member call on a `new` expression
// runs that method; a static method of a class expression is the class's
// own; and an instance handed on whole (passed, returned or stored) may
// have any method run, as a guess.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  claims,
  finding,
  graded,
  MCP,
  SDK,
  server,
  writtenCompare,
} from "./cli-reach-run.mjs";
import { skip } from "./cli-run.mjs";

const compare = writtenCompare();

const ECHO =
  'server.registerTool("echo", {}, async ({ text }) => ({ content: [{ type: "text", text }] }));\n';
// A class whose run() starts a process only a CLI branch calls.
const svc = (head) =>
  `${head} {\n  static async create(opts) { return new Svc(opts); }\n  static migrate(script) { return execFile("/usr/bin/psql", ["-f", script]); }\n  constructor(opts) { this.opts = opts; }\n  run(script) { return execFile("/usr/bin/psql", ["-f", script]); }\n}\nif (process.argv[2] === "migrate") new Svc({}).run(process.argv[3]);\n`;
const release = (tool, head = "class Svc") => ({
  "src/index.js": `${SDK}import { execFile } from "node:child_process";\n${server("1")}${svc(head)}${ECHO}${tool}export default server;\n`,
});
const withTool = (tool, head) =>
  compare(release("", head), release(tool, head), MCP);

describe("compare: what a tool reaches of a class", { skip }, () => {
  it("runs the constructor of a class a tool constructs, not its other methods", () => {
    const result = withTool(
      'server.registerTool("status", {}, async () => { const svc = new Svc({}); return { content: [{ type: "text", text: String(svc.opts) }] }; });\n',
    );
    assert.equal(result.result.status, 0, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M02", "medium"]]);
  });

  it("follows a member call on a new expression to that method", () => {
    const result = withTool(
      'server.registerTool("query", {}, async ({ script }) => ({ content: [], out: new Svc({}).run(script) }));\n',
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    const found = finding(result, "RW-M01");
    assert.equal(
      found.title,
      "MCP tool can start processes: registerTool() in src/index.js",
    );
    assert.match(
      claims(found),
      /constructs Svc through a call REA resolved, which calls run on the new instance, a method Svc defines; execFile\(\) runs there/,
    );
  });

  it("reads a static method of a class expression as the class's own", () => {
    const result = withTool(
      'server.registerTool("migrate", {}, async ({ script }) => ({ content: [], out: Svc.migrate(script) }));\n',
      "const Svc = class Service",
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    const found = finding(result, "RW-M01");
    assert.equal(
      found.title,
      "MCP tool can start processes: registerTool() in src/index.js",
    );
    assert.match(claims(found), /reads Svc\.migrate, a function Svc defines;/);
  });

  it("follows each method of an instance a function returns whole as a guess", () => {
    const result = withTool(
      'server.registerTool("open", {}, async () => { await Svc.create({}); return { content: [] }; });\n',
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    const found = finding(result, "RW-M01");
    assert.equal(
      found.title,
      "MCP tool may start processes: registerTool() in src/index.js",
    );
    assert.match(
      claims(found),
      /reads Svc\.create, a function Svc defines, which constructs Svc through a call REA resolved, which hands the new instance on whole \(passed, returned or stored\), so any method Svc defines may run, such as (run|migrate)/,
    );
  });

  it("follows each method of an instance passed straight to a call as a guess", () => {
    const result = withTool(
      'const wrap = (runner) => ({ runner });\nserver.registerTool("runner", {}, async () => ({ content: [], runner: wrap(new Svc({})) }));\n',
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    const found = finding(result, "RW-M01");
    assert.equal(
      found.title,
      "MCP tool may start processes: registerTool() in src/index.js",
    );
    assert.match(
      claims(found),
      /hands the new instance on whole \(passed, returned or stored\), so any method Svc defines may run, such as (run|migrate)/,
    );
    assert.ok(
      found.unknowns.some((unknown) =>
        /Code runs an instance's methods only through member reads/.test(
          unknown,
        ),
      ),
      JSON.stringify(found.unknowns),
    );
  });
});

describe("compare: what a tool reaches of an imported class", { skip }, () => {
  const RUNNER =
    'import { execFile } from "node:child_process";\nexport class Runner {\n  constructor() { this.bin = "/usr/bin/git"; }\n  run(args) { return execFile(this.bin, args); }\n}\n';
  const tools = (tool) => ({
    "src/index.js": `${SDK}import { Runner } from "./runner.js";\n${server("1")}${ECHO}${tool}export default server;\n`,
    "src/runner.js": RUNNER,
  });

  it("follows a member call on a new expression of an imported class to that method", () => {
    const result = compare(
      tools(""),
      tools(
        'server.registerTool("git", {}, async ({ args }) => { new Runner().run(args); return { content: [] }; });\n',
      ),
      MCP,
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    const found = finding(result, "RW-M01");
    assert.equal(
      found.title,
      "MCP tool can start processes: registerTool() in src/index.js",
    );
    assert.match(
      claims(found),
      /reads Runner, imported from src\/runner\.js, which calls run on the new instance, a method Runner defines; execFile\(\) runs there/,
    );
  });

  it("runs only the constructor of an imported class a local holds", () => {
    const result = compare(
      tools(""),
      tools(
        'server.registerTool("bin", {}, async () => { const runner = new Runner(); return { content: [{ type: "text", text: runner.bin }] }; });\n',
      ),
      MCP,
    );
    assert.equal(result.result.status, 0, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M02", "medium"]]);
  });
});
