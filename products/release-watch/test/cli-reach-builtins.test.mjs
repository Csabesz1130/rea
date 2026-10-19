// Runs the public CLI on small releases each test writes, for what built-in
// methods and iteration callbacks give a value, through REA's real facts:
// `find`, `concat` and `filter` give the receiver's elements, a Map's
// `get` gives its values, `Object.keys` gives no function, and a callback
// passed by name or run by `forEach` is not part of the value around it.
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
  SDK,
  server,
  table,
  tableServer,
  writtenCompare,
} from "./cli-reach-run.mjs";
import { skip } from "./cli-run.mjs";

const compare = writtenCompare();

// The same tools before and after; only the registration code changes.
const registering = (before, later) => {
  const tools = table(ECHO_TOOL, GIT_TOOL);
  return compare(
    { "src/index.js": before, "src/tools.js": tools, "src/git.js": GIT },
    { "src/index.js": later, "src/tools.js": tools, "src/git.js": GIT },
    MCP,
  );
};

// One more tool in the table, registered by the same code.
const growing = (loop) => {
  const index = tableServer(loop);
  return compare(
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
};

const TABLE_PATH =
  /which reads TOOLS, imported from src\/tools\.js, whose value holds functions only under handler, which reads runGit, imported from src\/git\.js; execFile\(\) runs there/;

const settledGit = (result) => {
  assert.equal(result.result.status, 2, result.result.stderr);
  assert.deepEqual(graded(result), [["RW-M01", "critical"]]);
  const found = finding(result, "RW-M01");
  assert.match(found.summary, /handler reaches execFile\(\)/);
  return claims(found);
};

describe("compare: what built-in methods give a value", { skip }, () => {
  it("follows the tool a table's find() call gives, not the predicate", () => {
    const result = registering(
      tableServer(""),
      tableServer(
        'const gitTool = TOOLS.find((tool) => tool.name === "git");\nserver.registerTool(gitTool.name, gitTool.config, gitTool.handler);',
      ),
    );
    assert.match(
      settledGit(result),
      /reads gitTool\.handler, whose initializer reads further bindings, which reads TOOLS, imported from src\/tools\.js, whose value holds functions only under handler/,
    );
  });

  it("follows the elements concat() and filter() give an iteration", () => {
    const claim = settledGit(
      growing(
        'TOOLS.concat([]).filter((tool) => tool.name !== "debug").forEach((tool) => server.registerTool(tool.name, tool.config, tool.handler));',
      ),
    );
    assert.match(
      claim,
      /reads tool\.handler, a parameter of the callback forEach\(\) runs for each element of its receiver, /,
    );
    assert.match(claim, TABLE_PATH);
  });

  it("follows the handlers a Map's get() gives", () => {
    const index = (names) =>
      `import { runGit } from "./git.js";\n${SDK}${server("1")}const handlers = new Map([\n  ["echo", async ({ text }) => ({ content: [{ type: "text", text }] })],\n${names.includes("git") ? '  ["git", async ({ args }) => ({ content: [], out: runGit(args) })],\n' : ""}]);\nfor (const name of ${JSON.stringify(names)}) {\n  const handler = handlers.get(name);\n  server.registerTool(name, {}, handler);\n}\nexport default server;\n`;
    const result = compare(
      { "src/index.js": index(["echo"]), "src/git.js": GIT },
      { "src/index.js": index(["echo", "git"]), "src/git.js": GIT },
      MCP,
    );
    assert.match(
      settledGit(result),
      /reads handler, whose initializer reads further bindings, which reads handlers\.get, whose initializer defines a function, which reads runGit, imported from src\/git\.js/,
    );
  });

  it("does not follow the keys Object.keys() gives into the values", () => {
    const index = (loop) =>
      `import { execFile } from "node:child_process";\n${SDK}${server("1")}const handlers = {\n  status: async () => ({ content: [{ type: "text", text: "ok" }] }),\n  deploy: async () => execFile("/usr/local/bin/deploy", ["--prod"]),\n};\nif (process.argv[2] === "deploy") handlers.deploy();\n${loop}export default server;\n`;
    const result = compare(
      { "src/index.js": index("") },
      {
        "src/index.js": index(
          'Object.keys(handlers).forEach((name) => server.registerTool(`describe_${name}`, {}, async () => ({ content: [{ type: "text", text: name }] })));\n',
        ),
      },
      MCP,
    );
    assert.equal(result.result.status, 0, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M02", "medium"]]);
  });
});

describe("compare: callbacks iteration methods run", { skip }, () => {
  it("follows a callback passed to forEach() by name", () => {
    const claim = settledGit(
      growing(
        "TOOLS.forEach(register);\nfunction register(tool) {\n  server.registerTool(tool.name, tool.config, tool.handler);\n}",
      ),
    );
    assert.match(
      claim,
      /reads tool\.handler, a parameter of the callback forEach\(\) runs for each element of its receiver, /,
    );
    assert.match(claim, TABLE_PATH);
  });

  it("does not take a forEach() callback after a table for part of it", () => {
    const signals =
      '["SIGHUP", "SIGUSR2"].forEach((signal) => process.on(signal, reloadIndex));\n';
    const index = (registration) =>
      `${SDK}import { execFile } from "node:child_process";\n${server("1")}${registration}async function reloadIndex() { execFile("/usr/bin/notes-index", ["--rebuild"]); }\n`;
    const result = compare(
      {
        "src/index.js": index(
          `server.registerTool("time", {}, async () => ({ content: [{ type: "text", text: new Date().toISOString() }] }));\n${signals}`,
        ),
      },
      {
        "src/index.js": index(
          `const TOOLS = [{ name: "time", run: async () => ({ content: [{ type: "text", text: new Date().toISOString() }] }) }];\n${signals}for (const tool of TOOLS) server.registerTool(tool.name, {}, () => tool.run());\n`,
        ),
      },
      MCP,
    );
    assert.equal(result.result.status, 0, result.result.stderr);
    assert.deepEqual(graded(result), []);
  });
});
