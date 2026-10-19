// Runs the public CLI on small releases each test writes, for bindings REA
// reports destructured: a tool table iterated with `for…of`, a tool object
// destructured in a declaration, a pattern's default values, the `[key,
// value]` pairs `Object.entries()` gives, and a destructuring of a computed
// member. Each binding takes the property REA reports, whatever its place
// in the pattern.
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

const ECHO =
  '  { name: "echo", config: {}, handler: async ({ text }) => ({ content: [{ type: "text", text }] }) },\n';
const NOTES =
  '  { name: "notes", config: {}, handler: async () => ({ content: [] }), cleanup: () => runGit(["gc"]) },\n';
const GIT_GC =
  '  { name: "gc", config: {}, handler: async () => ({ content: [], out: runGit(["gc"]) }) },\n';
const tools = (...entries) =>
  `import { runGit } from "./git.js";\nexport const TOOLS = [\n${entries.join("")}];\nexport const gc = () => runGit(["gc"]);\n`;
const loop = (pattern) =>
  `${SDK}import { TOOLS } from "./tools.js";\n${server("1")}for (const ${pattern} of TOOLS) server.registerTool(name, config, handler);\nexport default server;\n`;

const tableCompare = (pattern, added) =>
  compare(
    {
      "src/index.js": loop(pattern),
      "src/tools.js": tools(ECHO),
      "src/git.js": GIT,
    },
    {
      "src/index.js": loop(pattern),
      "src/tools.js": tools(ECHO, added),
      "src/git.js": GIT,
    },
    MCP,
  );

const unknownMatching = (found, pattern) =>
  found.unknowns.some((unknown) => pattern.test(unknown));

describe("compare: bindings a for…of loop destructures", { skip }, () => {
  it("follows the destructured member, not each whole element", () => {
    const result = tableCompare("{ name, config, handler }", NOTES);
    assert.equal(result.result.status, 2, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M01", "critical"]]);
    const found = finding(result, "RW-M01");
    // Only the unregistered cleanup member starts a process.
    assert.match(found.summary, /handler may reach execFile\(\)/);
    assert.match(
      claims(found),
      /reads handler, which REA reports destructured from handler of each element its for…of loop iterates, which reads TOOLS, imported from src\/tools\.js; REA names no function handler in its value/,
    );
    assert.ok(
      unknownMatching(found, /which function a member read selects/),
      JSON.stringify(found.unknowns),
    );
  });

  it("follows a binding destructured before the others of its pattern", () => {
    const result = tableCompare("{ handler, name, config }", GIT_GC);
    assert.equal(result.result.status, 2, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M01", "critical"]]);
    const found = finding(result, "RW-M01");
    assert.match(found.summary, /handler reaches execFile\(\)/);
    assert.match(
      claims(found),
      /The registration call reads handler, which REA reports destructured from handler of each element its for…of loop iterates, which reads TOOLS, imported from src\/tools\.js, whose value holds functions only under handler/,
    );
  });

  it("follows the value of each pair Object.entries() gives, not its key", () => {
    const index = (git) =>
      `import { execFile } from "node:child_process";\n${SDK}${server("1")}const HANDLERS = {\n  echo: async ({ text }) => ({ content: [{ type: "text", text }] }),\n${git ? '  git: async ({ args }) => ({ content: [], out: execFile("/usr/bin/git", args) }),\n' : ""}};\nfor (const [name, handler] of Object.entries(HANDLERS)) server.registerTool(name, {}, handler);\nexport default server;\n`;
    const result = compare(
      { "src/index.js": index(false) },
      { "src/index.js": index(true) },
      MCP,
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    const found = finding(result, "RW-M01");
    assert.match(found.summary, /handler reaches execFile\(\)/);
    assert.match(
      claims(found),
      /reads handler, which REA reports destructured from 1 of each element its for…of loop iterates, which reads HANDLERS, whose initializer defines/,
    );
  });
});

describe("compare: bindings a declaration destructures", { skip }, () => {
  it("follows a destructured member of an imported tool, wherever it sits in the pattern", () => {
    const index = (tool) =>
      `${SDK}${tool ? 'import { TOOL } from "./tool.js";\n' : ""}${server("1")}${tool ? "const { handler, name, config } = TOOL;\nserver.registerTool(name, config, handler);\n" : ""}export default server;\n`;
    const result = compare(
      { "src/index.js": index(false), "src/git.js": GIT },
      {
        "src/index.js": index(true),
        "src/git.js": GIT,
        "src/tool.js":
          'import { runGit } from "./git.js";\nexport const TOOL = { name: "gc", config: {}, handler: async () => ({ content: [], out: runGit(["gc"]) }) };\n',
      },
      MCP,
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    const found = finding(result, "RW-M01");
    assert.match(found.summary, /handler reaches execFile\(\)/);
    assert.match(
      claims(found),
      /The registration call reads handler, which REA reports destructured from handler of the value its declaration destructures, which reads TOOL, imported from src\/tool\.js, whose value holds functions only under handler/,
    );
  });
});

// A server that keeps an exec'ing function and a handler table in both
// releases; the new one registers `tool`.
const execIndex = (tool, head = "") =>
  `import { execFile } from "node:child_process";\n${SDK}${head}${server("1")}const runGit = (args) => execFile("/usr/bin/git", args);\nconst HANDLERS = {\n  git: async ({ args }) => ({ content: [], out: runGit(args) }),\n};\n${tool}export default server;\n`;
const execCompare = (tool, extra = {}, head = "") =>
  compare(
    { "src/index.js": execIndex("", head), ...extra },
    { "src/index.js": execIndex(tool, head), ...extra },
    MCP,
  );

describe(
  "compare: the default value of a destructured binding",
  { skip },
  () => {
    it("follows a default a declaration's pattern gives", () => {
      const result = execCompare(
        'const { name, handler = async () => ({ content: [], out: runGit(["status"]) }) } = OPTIONS;\nserver.registerTool(name, {}, handler);\n',
        { "src/options.js": 'export const OPTIONS = { name: "status" };\n' },
        'import { OPTIONS } from "./options.js";\n',
      );
      assert.equal(result.result.status, 2, result.result.stderr);
      const found = finding(result, "RW-M01");
      assert.match(found.summary, /handler reaches execFile\(\)/);
      assert.match(
        claims(found),
        /reads handler, whose default value in its destructuring pattern defines a function/,
      );
    });

    it("follows a default a for…of pattern gives each element", () => {
      const result = execCompare(
        'const gitStatus = async () => ({ content: [], out: runGit(["status"]) });\nfor (const { name, handler = gitStatus } of [{ name: "status" }, { name: "log" }]) server.registerTool(name, {}, handler);\n',
      );
      assert.equal(result.result.status, 2, result.result.stderr);
      const found = finding(result, "RW-M01");
      assert.match(found.summary, /handler reaches execFile\(\)/);
      assert.match(
        claims(found),
        /reads handler, whose default value in its destructuring pattern reads further bindings, which reads gitStatus, a function in the same module/,
      );
    });
  },
);

describe("compare: the pairs Object.entries() gives", { skip }, () => {
  it("takes an index into the pairs for a pair, not a key", () => {
    for (const tool of [
      "const [name, handler] = Object.entries(HANDLERS)[0];\nserver.registerTool(name, {}, handler);\n",
      "const pairs = Object.entries(HANDLERS);\nserver.registerTool(pairs[0][0], {}, pairs[0][1]);\n",
    ]) {
      const result = execCompare(tool);
      assert.equal(result.result.status, 2, result.result.stderr);
      assert.match(
        finding(result, "RW-M01").summary,
        /handler reaches execFile\(\)/,
        tool,
      );
    }
  });

  it("takes what find() gives for one pair, whose key holds no function", () => {
    const pick =
      'const entry = Object.entries(HANDLERS).find(([key]) => key === "git");\n';
    const keyOnly = execCompare(
      `${pick}server.registerTool(entry[0], {}, async () => ({ content: [] }));\n`,
    );
    assert.equal(keyOnly.result.status, 0, keyOnly.result.stderr);
    assert.equal(finding(keyOnly, "RW-M01"), undefined);
    const value = execCompare(
      `${pick}server.registerTool(entry[0], {}, entry[1]);\n`,
    );
    assert.equal(value.result.status, 2, value.result.stderr);
    assert.match(
      finding(value, "RW-M01").summary,
      /handler reaches execFile\(\)/,
    );
  });

  it("takes the pairs a binding holds one at a time through for…of and find()", () => {
    const head = "const pairs = Object.entries(HANDLERS);\n";
    for (const tool of [
      "for (const [name] of pairs) server.registerTool(name, {}, async () => ({ content: [] }));\n",
      'const entry = pairs.find(([key]) => key === "git");\nserver.registerTool(entry[0], {}, async () => ({ content: [] }));\n',
    ]) {
      const keyOnly = execCompare(`${head}${tool}`);
      assert.equal(keyOnly.result.status, 0, keyOnly.result.stderr);
      assert.equal(finding(keyOnly, "RW-M01"), undefined, tool);
    }
    const value = execCompare(
      `${head}for (const [name, handler] of pairs) server.registerTool(name, {}, handler);\n`,
    );
    assert.equal(value.result.status, 2, value.result.stderr);
    assert.match(
      claims(finding(value, "RW-M01")),
      /reads handler, which REA reports destructured from 1 of each element its for…of loop iterates, which reads pairs/,
    );
  });
});

describe(
  "compare: computed keys and members a pattern destructures",
  { skip },
  () => {
    it("follows all of what a destructuring of a computed member destructures as a guess", () => {
      const result = compare(
        { "src/index.js": `${SDK}${server("1")}export default server;\n` },
        {
          "src/index.js": `import { execFile } from "node:child_process";\n${SDK}${server("1")}const TOOLS = {\n  notes: { handler: async () => ({ content: [] }), cleanup: () => execFile("/usr/bin/git", ["gc"]) },\n};\nconst name = process.env.TOOL ?? "notes";\nconst { handler } = TOOLS[name];\nserver.registerTool(name, {}, handler);\nexport default server;\n`,
        },
        MCP,
      );
      assert.equal(result.result.status, 2, result.result.stderr);
      const found = finding(result, "RW-M01");
      assert.match(found.summary, /handler may reach execFile\(\)/);
      assert.match(
        claims(found),
        /reads handler, which REA reports destructured from a property REA does not resolve of the value its declaration destructures, which reads a computed member/,
      );
      assert.ok(
        unknownMatching(found, /from a computed member \(`= TOOLS\[name\]`\)/),
        JSON.stringify(found.unknowns),
      );
    });

    it("follows all of what a pattern with a computed key destructures as a guess", () => {
      const tools =
        'import { execFile } from "node:child_process";\nexport const TOOL = {\n  async handler() { return { content: [] }; },\n  cleanup() { return execFile("/usr/bin/git", ["gc"]); },\n};\n';
      const index = (body) =>
        `${SDK}import { TOOL } from "./tools.js";\n${server("1")}const key = process.env.TOOL_KEY || "handler";\n${body}export default server;\n`;
      const before = { "src/index.js": index(""), "src/tools.js": tools };
      const computed = compare(
        before,
        {
          "src/index.js": index(
            'const { [key]: run } = TOOL;\nserver.registerTool("notes", {}, run);\n',
          ),
          "src/tools.js": tools,
        },
        MCP,
      );
      assert.equal(computed.result.status, 2, computed.result.stderr);
      const found = finding(computed, "RW-M01");
      assert.match(found.summary, /handler may reach execFile\(\)/);
      assert.match(
        claims(found),
        /reads run, whose value REA could not project from the value its declaration destructures through a computed key, so Release Watch followed all of that value/,
      );
      assert.ok(
        unknownMatching(
          found,
          /through a computed key \(`\{ \[key\]: run \}`\)/,
        ),
        JSON.stringify(found.unknowns),
      );
      // A computed key of an object literal is no pattern of the declaration
      // after it.
      const literal = compare(
        before,
        {
          "src/index.js": index(
            'const flags = { [key]: true };\nconst run = TOOL;\nserver.registerTool("notes", {}, run.handler);\n',
          ),
          "src/tools.js": tools,
        },
        MCP,
      );
      assert.equal(literal.result.status, 0, literal.result.stderr);
      assert.equal(finding(literal, "RW-M01"), undefined);
    });
  },
);
