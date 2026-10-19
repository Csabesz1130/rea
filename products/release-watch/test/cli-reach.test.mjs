// Runs the public CLI on small releases each test writes, for where a
// value REA reports ends and which function a member read of it selects,
// through REA's real facts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  claims,
  ECHO_TOOL,
  finding,
  GIT,
  GIT_TOOL,
  graded,
  MCP,
  NAMED_ECHO_TOOL,
  NAMED_GIT_TOOL,
  SDK,
  server,
  table,
  tableServer,
  writtenCompare,
} from "./cli-reach-run.mjs";
import { skip } from "./cli-run.mjs";

const compare = writtenCompare();

describe("compare: where a tool table's initializer ends", { skip }, () => {
  it("does not end a tool table at a local variable inside one of its handlers", () => {
    const index = tableServer(
      "for (const tool of TOOLS) server.registerTool(tool.name, tool.config, tool.handler);",
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
      /reads tool\.handler, .*reads TOOLS, imported from src\/tools\.js, whose value holds functions only under handler, which reads runGit, imported from src\/git\.js; execFile\(\) runs there/,
    );
  });

  it("does not end a tool table at a handler written as a named function expression", () => {
    const index = tableServer(
      "for (const tool of TOOLS) server.registerTool(tool.name, tool.config, tool.handler);",
    );
    const result = compare(
      {
        "src/index.js": index,
        "src/tools.js": table(NAMED_ECHO_TOOL),
        "src/git.js": GIT,
      },
      {
        "src/index.js": index,
        "src/tools.js": table(NAMED_ECHO_TOOL, NAMED_GIT_TOOL),
        "src/git.js": GIT,
      },
      MCP,
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M01", "critical"]]);
    assert.match(
      claims(finding(result, "RW-M01")),
      /reads TOOLS, imported from src\/tools\.js, whose value holds functions only under handler, which reads runGit, imported from src\/git\.js; execFile\(\) runs there/,
    );
  });

  it("ends an exported table where REA's export statement ends", () => {
    const tools =
      'import { execFile } from "node:child_process";\nimport { watch } from "./watch.js";\nexport const TOOLS = [{ name: "time", config: {}, handler: async () => ({ content: [] }) }];\nwatch(() => execFile("/usr/bin/sync"));\n';
    const files = (loop) => ({
      "src/index.js": tableServer(loop),
      "src/tools.js": tools,
      "src/watch.js": "export const watch = (fn) => fn;\n",
    });
    const result = compare(
      files(""),
      files(
        "for (const tool of TOOLS) server.registerTool(tool.name, tool.config, tool.handler);",
      ),
      MCP,
    );
    assert.equal(result.result.status, 0, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M02", "medium"]]);
  });
});

describe("compare: which statements end a value", { skip }, () => {
  it("ends a handler map at a timer that follows it", () => {
    const head = `import { execFile } from "node:child_process";\n${SDK}${server("1")}const handlers = { status: async () => ({ content: [{ type: "text", text: "ok" }] }) };\nsetInterval(() => execFile("/usr/bin/sync"), 60000);\n`;
    const result = compare(
      { "src/index.js": `${head}export default server;\n` },
      {
        "src/index.js": `${head}server.registerTool("status", {}, handlers.status);\nexport default server;\n`,
      },
      MCP,
    );
    assert.equal(result.result.status, 0, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M02", "medium"]]);
  });

  it("ends a table at a listener registration that follows it", () => {
    const reload =
      'function reloadIndex() { execFile("/usr/bin/notes-index", ["--rebuild"]); }\n';
    const head = `${SDK}import { execFile } from "node:child_process";\n`;
    const time =
      'async () => ({ content: [{ type: "text", text: new Date().toISOString() }] })';
    const result = compare(
      {
        "src/index.js": `${head}${server("1.0.0")}server.registerTool("time", {}, ${time});\n${reload}process.on("SIGHUP", reloadIndex);\n`,
      },
      {
        "src/index.js": `${head}${server("1.1.0")}const TOOLS = [{ name: "time", run: ${time} }];\nprocess.on("SIGHUP", reloadIndex);\nfor (const tool of TOOLS) server.registerTool(tool.name, {}, () => tool.run());\n${reload}`,
      },
      MCP,
    );
    assert.equal(result.result.status, 0, result.result.stderr);
    assert.deepEqual(graded(result), []);
  });

  it("ends a server's initializer at the call that creates it", () => {
    const head = `import { execFile } from "node:child_process";\n${SDK}`;
    const hook =
      'process.on("SIGTERM", () => {\n  execFile("/usr/bin/pkill", ["-f", "ops-helper"]);\n  process.exit(0);\n});\n';
    const echo =
      'server.registerTool("echo", {}, async ({ text }) => ({ content: [{ type: "text", text }] }));\n';
    const result = compare(
      {
        "src/index.js": `${head}${server("1.0.0")}${hook}${echo}export default server;\n`,
      },
      {
        "src/index.js": `${head}${server("1.1.0")}${hook}${echo}server.registerTool("ping", {}, async () => ({ content: [{ type: "text", text: "pong" }] }));\nexport default server;\n`,
      },
      MCP,
    );
    assert.equal(result.result.status, 0, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M02", "medium"]]);
  });

  it("says how many old registrations reached an unchanged process site", () => {
    const head = `import { execFile } from "node:child_process";\n${SDK}`;
    const git =
      'function runGit(args) {\n  return execFile("/usr/bin/git", args);\n}\nserver.registerTool("git_status", {}, async () => ({ content: [], out: runGit(["status"]) }));\n';
    const result = compare(
      {
        "src/index.js": `${head}${server("1.0.0")}${git}export default server;\n`,
      },
      {
        "src/index.js": `${head}${server("1.1.0")}${git}server.registerTool("git_log", {}, async () => ({ content: [], out: runGit(["log", "-1"]) }));\nexport default server;\n`,
      },
      MCP,
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    assert.ok(
      finding(result, "RW-M01").evidence.some((item) =>
        /^execFile\(\) creates a child process \(also in v1\.0\.0, where Release Watch connected 1 tool registration to it\)$/.test(
          item.claim,
        ),
      ),
      JSON.stringify(finding(result, "RW-M01").evidence),
    );
  });
});

const repo = (registration) =>
  `import { execFile } from "node:child_process";\n${SDK}${server("1")}class Repo {\n  static async status() {\n    return { content: [{ type: "text", text: "clean" }] };\n  }\n  static async gc() {\n    return execFile("/usr/bin/git", ["gc", "--auto"]);\n  }\n}\nif (process.argv[2] === "gc") Repo.gc();\n${registration}export default server;\n`;
const commands = (registration) =>
  `import { execFile } from "node:child_process";\n${SDK}${server("1")}const commands = {\n  status: async () => ({ content: [{ type: "text", text: "ok" }] }),\n  deploy: async () => execFile("/usr/local/bin/deploy", ["--prod"]),\n};\nif (process.argv[2] === "deploy") commands.deploy();\n${registration}export default server;\n`;
const CACHE =
  'import { execFile } from "node:child_process";\nexport const purgeCache = () => execFile("/bin/rm", ["-rf", "/var/cache/ops"]);\n';
const sessions = (registrations) =>
  `${SDK}import { purgeCache } from "./cache.js";\n${server("1")}class Session {\n  clear() {\n    this.items = [];\n  }\n}\nexport const session = new Session();\nconst handlers = {\n  echo: async ({ text }) => ({ content: [{ type: "text", text }] }),\n  clear: purgeCache,\n};\n${registrations}export default server;\n`;
const HANDLERS =
  'import { exec } from "node:child_process";\nexport default {\n  echo: async ({ text }) => ({ content: [{ type: "text", text }] }),\n  shell: async ({ cmd }) => ({ content: [], out: exec(cmd) }),\n};\n';
const handlersServer = (registrations) =>
  `${SDK}import handlers from "./handlers.js";\n${server("1")}${registrations}export default server;\n`;

describe("compare: which function a member read selects", { skip }, () => {
  it("selects a class's static method, not the whole class", () => {
    const result = compare(
      { "src/index.js": repo("") },
      {
        "src/index.js": repo(
          'server.registerTool("status", {}, Repo.status);\n',
        ),
      },
      MCP,
    );
    assert.equal(result.result.status, 0, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M02", "medium"]]);
  });

  it("does not take another class's method of the same name for a map member", () => {
    const echo = 'server.registerTool("echo", {}, handlers.echo);\n';
    const result = compare(
      { "src/index.js": sessions(echo), "src/cache.js": CACHE },
      {
        "src/index.js": sessions(
          `${echo}server.registerTool("clear", {}, handlers.clear);\n`,
        ),
        "src/cache.js": CACHE,
      },
      MCP,
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M01", "critical"]]);
    assert.match(
      claims(finding(result, "RW-M01")),
      /reads handlers\.clear; REA names no function clear in the initializer of handlers, so Release Watch followed the bindings it reads, which reads purgeCache, imported from src\/cache\.js/,
    );
  });

  it("says when it cannot tell which function of a map a member read selects", () => {
    const result = compare(
      { "src/index.js": commands("") },
      {
        "src/index.js": commands(
          'server.registerTool("status", {}, commands.status);\n',
        ),
      },
      MCP,
    );
    const found = finding(result, "RW-M01");
    assert.match(found.summary, /whose handler may reach execFile\(\)/);
    assert.match(
      claims(found),
      /reads commands\.status; REA names no function status in the initializer of commands, so Release Watch followed each function it defines that could be status; execFile\(\) runs there/,
    );
    assert.ok(
      found.unknowns.some((unknown) =>
        /do not say which function a member read selects/.test(unknown),
      ),
      JSON.stringify(found.unknowns),
    );
  });

  it("follows a member of a default-exported object", () => {
    const echo = 'server.registerTool("echo", {}, handlers.echo);\n';
    const result = compare(
      { "src/index.js": handlersServer(echo), "src/handlers.js": HANDLERS },
      {
        "src/index.js": handlersServer(
          `${echo}server.registerTool("shell", {}, handlers.shell);\n`,
        ),
        "src/handlers.js": HANDLERS,
      },
      MCP,
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M01", "critical"]]);
    assert.match(
      claims(finding(result, "RW-M01")),
      /reads handlers\.shell, the default export of src\/handlers\.js/,
    );
  });
});
