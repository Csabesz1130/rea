// Runs the public CLI on small MCP servers each test writes, for which
// imports make a component an MCP server, which of its calls register
// tools and how RW-M01 words what a tool reaches, through REA's real
// facts: the v2 SDK, fastmcp and a bundled FastMCP, dispatchers that handle
// requests other than tool calls, guessed paths and relocated sites.
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
  SHELL,
  writtenCompare,
} from "./cli-reach-run.mjs";
import { skip } from "./cli-run.mjs";

const compare = writtenCompare();

const GIT_LOG =
  'server.registerTool("git_log", {}, async ({ ref }) => ({ content: [], out: runGit(["log", ref]) }));\n';
const ECHO =
  'server.registerTool("echo", {}, async ({ text }) => ({ content: [{ type: "text", text }] }));\n';

describe("compare: which imports make an MCP server", { skip }, () => {
  it("recognises a server on the v2 SDK and follows its registerTool calls", () => {
    const head = `import { McpServer } from "@modelcontextprotocol/server";\nimport { runGit } from "./git.js";\n${server("1")}`;
    const result = compare(
      { "src/index.js": `${head}${ECHO}`, "src/git.js": GIT },
      { "src/index.js": `${head}${ECHO}${GIT_LOG}`, "src/git.js": GIT },
      {
        type: "module",
        main: "src/index.js",
        dependencies: { "@modelcontextprotocol/server": "2.3.1" },
      },
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M01", "critical"]]);
    const found = finding(result, "RW-M01");
    assert.equal(
      found.title,
      "MCP tool can start processes: registerTool() in src/index.js",
    );
    assert.match(
      found.summary,
      /registers an MCP tool with registerTool\(\) at src\/index\.js:5 whose handler reaches execFile\(\) in src\/git\.js/,
    );
    assert.match(
      claims(found),
      /src\/index\.js imports @modelcontextprotocol\/server, an MCP server SDK, and counts the component's registerTool\(\) calls as tool registrations/,
    );
  });

  it("follows addTool calls of a server built on fastmcp", () => {
    const head =
      'import { FastMCP } from "fastmcp";\nimport { runGit } from "./git.js";\nconst server = new FastMCP({ name: "ops", version: "1.0.0" });\nserver.addTool({ name: "echo", execute: async ({ text }) => text });\n';
    const result = compare(
      { "src/index.js": head, "src/git.js": GIT },
      {
        "src/index.js": `${head}server.addTool({ name: "git_log", execute: async ({ ref }) => runGit(["log", ref]) });\n`,
        "src/git.js": GIT,
      },
      {
        type: "module",
        main: "src/index.js",
        dependencies: { fastmcp: "4.22.10" },
      },
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M01", "critical"]]);
    const found = finding(result, "RW-M01");
    assert.equal(
      found.title,
      "MCP tool can start processes: addTool() in src/index.js",
    );
    assert.match(
      claims(found),
      /imports fastmcp, an MCP server framework, and counts the component's addTool\(\) and addTools\(\) calls as tool registrations/,
    );
  });

  it("counts addTool calls of a FastMCP class bundled beside the SDK import", () => {
    const bundle = (tools) =>
      `import { Server } from "@modelcontextprotocol/sdk/server/index.js";\nimport { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";\nclass FastMCP {\n  #tools = [];\n  #server = new Server({ name: "fc", version: "1" }, { capabilities: { tools: {} } });\n  addTool(tool) {\n    this.#tools.push(tool);\n  }\n  start() {\n    this.#server.setRequestHandler(CallToolRequestSchema, async (request) => this.#tools.find((tool) => tool.name === request.params.name).execute(request.params.arguments));\n  }\n}\nconst server = new FastMCP();\n${tools}server.start();\n`;
    const scrape =
      'server.addTool({ name: "scrape", execute: async ({ url }) => `scraped ${url}` });\n';
    const search =
      'server.addTool({ name: "search", execute: async ({ query }) => `found ${query}` });\n';
    const result = compare(
      { "dist/index.js": bundle(scrape) },
      { "dist/index.js": bundle(`${scrape}${search}`) },
      { ...MCP, main: "dist/index.js" },
    );
    assert.equal(result.result.status, 0, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M02", "medium"]]);
    const found = finding(result, "RW-M02");
    assert.match(found.title, /^New MCP tool registrations \(\d+ → \d+\)$/);
    assert.match(
      claims(found),
      /counts addTool\(\) calls as tool registrations because dist\/index\.js, which imports an MCP server SDK, defines a method addTool/,
    );
  });
});

describe("compare: how RW-A03 words a new MCP SDK package", { skip }, () => {
  it("grades a switch to the v2 SDK as a new server SDK, not a new server or package", () => {
    const tool =
      'server.registerTool("echo", {}, async ({ text }) => ({ content: [{ type: "text", text }] }));\nexport default server;\n';
    const result = compare(
      { "src/index.js": `${SDK}${server("1")}${tool}` },
      {
        "src/index.js": `import { McpServer } from "@modelcontextprotocol/server";\n${server("1")}${tool}`,
      },
      MCP,
    );
    assert.equal(result.result.status, 0, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-A03", "low"]]);
    const found = finding(result, "RW-A03");
    assert.equal(
      found.title,
      "New MCP server SDK: @modelcontextprotocol/server",
    );
    assert.match(
      found.summary,
      /now serves MCP through @modelcontextprotocol\/server; v1\.0\.0 already ran an MCP server through @modelcontextprotocol\/sdk/,
    );
  });

  it("words a new HTTP transport of the v2 SDK as serving MCP, not as talking to AI models", () => {
    const head = `import { McpServer } from "@modelcontextprotocol/server";\n${server("1")}${ECHO}`;
    const pkg = (extra) => ({
      type: "module",
      main: "src/index.js",
      dependencies: { "@modelcontextprotocol/server": "2.3.1", ...extra },
    });
    const result = compare(
      { "src/index.js": `${head}export default server;\n` },
      {
        "src/index.js": `import { createMcpExpressApp } from "@modelcontextprotocol/express";\n${head}export const app = createMcpExpressApp(server);\nexport default server;\n`,
      },
      pkg({ "@modelcontextprotocol/express": "2.3.1" }),
    );
    assert.equal(result.result.status, 0, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-A03", "low"]]);
    const found = finding(result, "RW-A03");
    assert.equal(
      found.title,
      "New MCP HTTP transport: @modelcontextprotocol/express",
    );
    assert.match(
      found.summary,
      /now uses @modelcontextprotocol\/express, which serves an MCP server over HTTP\./,
    );
    assert.doesNotMatch(
      `${found.why} ${found.recommendation}`,
      /AI model|the model/,
    );
  });
});

describe("compare: which dispatcher calls register MCP tools", { skip }, () => {
  const v1 =
    'import { execFile } from "node:child_process";\nimport { Server } from "@modelcontextprotocol/sdk/server/index.js";\nimport { CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";\nconst server = new Server({ name: "notes", version: "1" }, { capabilities: { tools: {}, resources: {} } });\nserver.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: "text", text: String(request.params.name) }] }));\nserver.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));\n';

  it("reports a resource handler that starts a process as process execution, not a tool", () => {
    const result = compare(
      { "src/index.js": `${v1}export default server;\n` },
      {
        "src/index.js": `${v1}server.setRequestHandler(ReadResourceRequestSchema, async (request) => {\n  execFile("/usr/bin/git", ["log", "-n", "20"]);\n  return { contents: [{ uri: request.params.uri, text: "see log" }] };\n});\nexport default server;\n`,
      },
      MCP,
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-P01", "high"]]);
  });

  it("names and cites only the CallTool dispatcher when ListTools reads the same tool table", () => {
    const tools = (...entries) =>
      `const tools = [\n  { name: "echo", handler: async ({ text }) => ({ content: [{ type: "text", text }] }) },\n${entries.join("")}];\n`;
    const index = (list) =>
      `import { Server } from "@modelcontextprotocol/sdk/server/index.js";\nimport { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";\nimport { runGit } from "./git.js";\n${list}const server = new Server({ name: "ops", version: "1" }, { capabilities: { tools: {} } });\nserver.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(({ name }) => ({ name })) }));\nserver.setRequestHandler(CallToolRequestSchema, async (request) => tools.find((tool) => tool.name === request.params.name).handler(request.params.arguments));\nexport default server;\n`;
    const result = compare(
      { "src/index.js": index(tools()), "src/git.js": GIT },
      {
        "src/index.js": index(
          tools(
            '  { name: "git_log", handler: async ({ ref }) => ({ content: [], out: runGit(["log", ref]) }) },\n',
          ),
        ),
        "src/git.js": GIT,
      },
      MCP,
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M01", "critical"]]);
    const found = finding(result, "RW-M01");
    assert.match(
      found.title,
      /start processes: CallTool request handler in src\/index\.js$/,
    );
    assert.match(
      found.summary,
      /handles MCP tool calls through setRequestHandler\(\) at src\/index\.js:10, and that handler (may )?reach/,
    );
    assert.deepEqual(
      found.evidence
        .filter((item) => item.claim.startsWith("setRequestHandler() call"))
        .map((item) => item.location.line),
      [10],
    );
    const table = result.report.components[0].inventory.find(
      (section) => section.id === "mcp-registrations",
    );
    assert.deepEqual(table.rows, [
      ["src/index.js", "setRequestHandler()", "1 → 1"],
    ]);
  });
});

describe(
  "compare: how a dispatcher's first argument names CallTool",
  { skip },
  () => {
    const V1 =
      'import { execFile } from "node:child_process";\nimport { Server } from "@modelcontextprotocol/sdk/server/index.js";\nimport { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";\n';
    const GIT_CALL = (indent) =>
      `${indent}execFile("/usr/bin/git", ["log"]);\n${indent}return { content: [] };\n`;

    it("follows a minified dispatcher that imports CallToolRequestSchema under another name", () => {
      const index = (call) =>
        `import{Server as s}from"@modelcontextprotocol/sdk/server/index.js";import{CallToolRequestSchema as c,ListToolsRequestSchema as l}from"@modelcontextprotocol/sdk/types.js";import{runGit as g}from"./git.js";const n=new s({name:"ops",version:"1"},{capabilities:{tools:{}}});n.setRequestHandler(l,async()=>({tools:[{name:"echo"},{name:"log"}]}));n.setRequestHandler(c,async t=>${call});export default n;export const cli=()=>g(["status"]);\n`;
      const result = compare(
        {
          "src/index.js": index(
            '({content:[{type:"text",text:String(t.params.name)}]})',
          ),
          "src/git.js": GIT,
        },
        {
          "src/index.js": index(
            't.params.name==="log"?{content:[],out:g(["log",String(t.params.arguments.ref)])}:{content:[{type:"text",text:String(t.params.name)}]}',
          ),
          "src/git.js": GIT,
        },
        MCP,
      );
      assert.equal(result.result.status, 2, result.result.stderr);
      assert.deepEqual(graded(result), [["RW-M01", "critical"]]);
      const found = finding(result, "RW-M01");
      assert.equal(
        found.title,
        "MCP tool can start processes: CallTool request handler in src/index.js",
      );
      assert.ok(
        found.evidence.some(
          (item) =>
            item.claim ===
            "setRequestHandler() call whose first argument reads c, an import of CallToolRequestSchema",
        ),
        found.evidence.map((item) => item.claim).join("\n"),
      );
    });

    it("follows dispatchers on a receiver that is a call", () => {
      const index = (handler) =>
        `${V1}const sessions = new Map();\nlet instance;\nconst getServer = () => (instance ??= new Server({ name: "ops", version: "1" }, { capabilities: { tools: {} } }));\nexport const attach = (sessionId) => {\n  sessions.set(sessionId, new Server({ name: "ops", version: "1" }, { capabilities: { tools: {} } }));\n  sessions.get(sessionId).setRequestHandler(CallToolRequestSchema, async (request) => {\n${handler}  });\n};\ngetServer().setRequestHandler(CallToolRequestSchema, async (request) => {\n${handler}});\n`;
      const result = compare(
        { "src/index.js": index("    return { content: [] };\n") },
        { "src/index.js": index(GIT_CALL("    ")) },
        MCP,
      );
      assert.equal(result.result.status, 2, result.result.stderr);
      assert.deepEqual(graded(result), [["RW-M01", "critical"]]);
      assert.deepEqual(
        finding(result, "RW-M01")
          .evidence.filter((item) =>
            item.claim.startsWith("setRequestHandler() call"),
          )
          .map((item) => item.location.line)
          .sort((a, b) => a - b),
        [9, 14],
      );
    });

    it("does not take another request's handler for a tool dispatcher", () => {
      // The receiver's call reads CallToolRequestSchema, and the import named
      // after it is ListToolsRequestSchema: neither handler dispatches tool calls.
      const index = (handler) =>
        `import { execFile } from "node:child_process";\nimport { Server } from "@modelcontextprotocol/sdk/server/index.js";\nimport * as types from "@modelcontextprotocol/sdk/types.js";\nimport { ListToolsRequestSchema as CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";\nconst server = new Server({ name: "ops", version: "1" }, { capabilities: { tools: {}, resources: {} } });\nconst serverFor = (schema) => (schema ? server : null);\nserverFor(types.CallToolRequestSchema).setRequestHandler(types.ListResourcesRequestSchema, async () => {\n${handler}});\nserver.setRequestHandler(CallToolRequestSchema, async () => {\n${handler}});\nexport default server;\n`;
      const result = compare(
        { "src/index.js": index("  return { content: [] };\n") },
        { "src/index.js": index(GIT_CALL("  ")) },
        MCP,
      );
      assert.equal(result.result.status, 2, result.result.stderr);
      assert.deepEqual(graded(result), [["RW-P01", "high"]]);
    });
  },
);

describe("compare: how RW-M01 words what a tool reaches", { skip }, () => {
  it("does not take a tool that moved from tool() to registerTool() for a new capability", () => {
    const head = `${SDK}import { runGit } from "./git.js";\n${server("1")}`;
    const result = compare(
      {
        "src/index.js": `${head}server.tool("git_log", "Show the log", async ({ ref }) => ({ content: [], out: runGit(["log", ref]) }));\nexport default server;\n`,
        "src/git.js": GIT,
      },
      {
        "src/index.js": `${head}${GIT_LOG}export default server;\n`,
        "src/git.js": GIT,
      },
      MCP,
    );
    assert.equal(result.result.status, 0, result.result.stderr);
    assert.deepEqual(graded(result), []);
  });

  it("hedges the title and why of a finding that rests on a guessed path", () => {
    const head = `${SDK}import { execFile } from "node:child_process";\n${server("1")}const handlers = {\n  status: async () => ({ content: [{ type: "text", text: "ok" }] }),\n  deploy: async () => ({ content: [], out: execFile("/usr/local/bin/deploy", ["--prod"]) }),\n};\nserver.registerTool("deploy", {}, handlers.deploy);\n`;
    const result = compare(
      { "src/index.js": `${head}export default server;\n` },
      {
        "src/index.js": `${head}server.registerTool("status", {}, handlers.status);\nexport default server;\n`,
      },
      MCP,
    );
    assert.equal(result.result.status, 2, result.result.stderr);
    assert.deepEqual(graded(result), [["RW-M01", "critical"]]);
    const found = finding(result, "RW-M01");
    assert.equal(
      found.title,
      "MCP tool may start processes: registerTool() in src/index.js",
    );
    assert.match(found.summary, /whose handler may reach execFile\(\)/);
    assert.match(
      found.why,
      /^Release Watch could not settle that the handler reaches this site; if it does, any agent/,
    );
  });
});

describe(
  "compare: when RW-M01 cannot settle that a connection is new",
  { skip },
  () => {
    it("hedges a connection the old side may have made through a file REA could not analyze", () => {
      const index = (tools) =>
        `${SDK}import { runGit } from "./git.js";\n${tools ? 'import { runDeploy } from "./deploy.js";\n' : ""}${server("1")}${GIT_LOG}${tools}export default server;\n`;
      const git = (tail) =>
        `import { execFile } from "node:child_process";\nexport const runGit = (args) => execFile("/usr/bin/git", args);\n${tail}`;
      const result = compare(
        // REA cannot parse the old git.js, so its facts show no tool reaching git.
        {
          "src/index.js": index(""),
          "src/git.js": git("export const broken = (;\n"),
        },
        {
          "src/index.js": index(
            'server.registerTool("deploy", {}, async () => ({ content: [], out: runDeploy() }));\n',
          ),
          "src/git.js": git("export const fixed = () => 1;\n"),
          "src/deploy.js":
            'import { execFile } from "node:child_process";\nexport const runDeploy = () => execFile("/usr/local/bin/deploy", ["--prod"]);\n',
        },
        MCP,
      );
      assert.equal(result.result.status, 2, result.result.stderr);
      const titles = result.report.findings
        .filter((item) => item.rule === "RW-M01")
        .map((item) => [item.title, item.summary]);
      assert.deepEqual(titles.map(([title]) => title).sort(), [
        "MCP tool can start processes, perhaps as before: registerTool() in src/index.js",
        "MCP tool can start processes: registerTool() in src/index.js",
      ]);
      const hedged = titles.find(([title]) => title.includes("perhaps"));
      assert.match(
        hedged[1],
        /reaches execFile\(\) in src\/git\.js\. REA did not fully analyze src\/git\.js in v1\.0\.0, through which its tools may have reached the site the same way\.$/,
      );
      assert.match(
        titles.find(([title]) => !title.includes("perhaps"))[1],
        /reaches execFile\(\) in src\/deploy\.js\.$/,
      );
    });

    it("counts no tool in a file the old side shipped with the same content", () => {
      const steps = Array.from(
        { length: 60 },
        (_, i) =>
          `export function step${i}(value) {\n  const next = value + ${i};\n  return { next, text: "hello " + next };\n}\n`,
      );
      const index = (count) =>
        `import { server } from "./server.js";\n${steps.slice(0, count).join("")}`;
      const tools = `${SDK}import { execFile } from "node:child_process";\nexport ${server("1")}server.registerTool("deploy", {}, async () => ({ content: [], pid: execFile("/usr/local/bin/deploy", ["--prod"]).pid }));\n`;
      // REA's global node limit runs out in the old index.js, so its facts
      // show no tool in the old server.js.
      const old = { "index.js": index(60), "server.js": tools };
      const limit = ["--max-semantic-nodes", "500"];
      const pkg = { ...MCP, main: "index.js" };
      const kept = compare(
        old,
        { "index.js": index(30), "server.js": tools },
        pkg,
        limit,
      );
      assert.equal(kept.result.status, 0, kept.result.stderr);
      assert.deepEqual(graded(kept), []);
      const [table] = kept.report.components[0].inventory.filter(
        (entry) => entry.id === "mcp-registrations",
      );
      assert.deepEqual(table.rows, [
        ["server.js", "registerTool()", "0 → 1 (unchanged file)"],
      ]);
      const changed = compare(
        old,
        { "index.js": index(30), "server.js": `// 1.1.0\n${tools}` },
        pkg,
        limit,
      );
      assert.equal(changed.result.status, 2, changed.result.stderr);
      assert.equal(
        finding(changed, "RW-M01").title,
        "MCP tool can start processes, perhaps as before: registerTool() in server.js",
      );
    });

    it("says a tool's new site may be an old one in a file REA could not fully examine now", () => {
      const head = 'import { execFile } from "node:child_process";\n';
      const status =
        'export const runStatus = () => execFile("/usr/bin/git", ["status"]);\n';
      const pad = Array.from(
        { length: 60 },
        (_, i) =>
          `export const pad${i} = (value) => ({ id: ${i}, value: String(value).trim() + "-${i}" });\n`,
      ).join("");
      const tools = (extra) =>
        `${SDK}${head}import "./big.js";\n${server("1")}${ECHO}${extra}export default server;\n`;
      const result = compare(
        { "src/big.js": `${head}${status}`, "src/server.js": tools("") },
        {
          // The old site now lies past REA's per-file node ceiling.
          "src/big.js": `${head}${pad}${status}`,
          "src/server.js": tools(
            'server.registerTool("status", {}, async () => ({ content: [], pid: execFile("/usr/bin/git", ["status"]).pid }));\n',
          ),
        },
        { ...MCP, main: "src/server.js" },
        ["--max-semantic-nodes-per-file", "150"],
      );
      assert.equal(result.result.status, 2, result.result.stderr);
      const found = finding(result, "RW-M01");
      assert.equal(
        found.title,
        "MCP tool can start processes: registerTool() in src/server.js",
      );
      assert.ok(
        found.unknowns.includes(
          "v1.0.0 ran execFile() with the same command in src/big.js, which REA could not fully examine in v1.1.0; this may be the same call, moved.",
        ),
        found.unknowns.join("\n"),
      );
    });

    it("words a site in a bundle the diff pools with others of its name by the diff's status", () => {
      // Two chunks share dist/config.js once their content hash is removed,
      // so the diff compares their sites under that pooled key.
      const tools = (chunk, extra) =>
        `${SDK}import { launch } from "./config-${chunk}.js";\n${server("1")}${ECHO}${extra}export default server;\n`;
      const result = compare(
        {
          "dist/index.js": tools("Ab12Cd34", ""),
          "dist/config-Ab12Cd34.js":
            'import { execSync } from "node:child_process";\nexport const launch = () => execSync("git --version");\n',
          "dist/config-Ef56Gh78.js": "export const b = 1;\n",
        },
        {
          "dist/index.js": tools(
            "Ij90Kl12",
            'server.registerTool("run", {}, async ({ cmd }) => ({ content: [], pid: launch(cmd).pid }));\n',
          ),
          "dist/config-Ij90Kl12.js":
            'import { spawn } from "node:child_process";\nexport const launch = (cmd) => spawn(cmd);\n',
          "dist/config-Mn34Op56.js": "export const b = 2;\n",
        },
        { ...MCP, main: "dist/index.js" },
      );
      assert.equal(result.result.status, 2, result.result.stderr);
      assert.match(
        finding(result, "RW-M01")
          .evidence.map((item) => item.claim)
          .join("\n"),
        /spawn\(\) creates a child process with a command REA did not resolve \((absent from|not observed in) v1\.0\.0/,
      );
    });

    it("says the old tools reached a site its unresolved command may have moved from", () => {
      const tools = (module, extra = "") =>
        `${SDK}import { runShell } from "./${module}.js";\n${server("1")}server.registerTool("run", {}, async ({ command }) => ({ content: [], out: runShell(command) }));\n${extra}export default server;\n`;
      const result = compare(
        { "src/index.js": tools("shell"), "src/shell.js": SHELL },
        {
          "src/index.js": tools(
            "exec",
            'server.registerTool("run_windows", {}, async ({ command }) => ({ content: [], out: runShell(`cmd /c ${command}`) }));\n',
          ),
          "src/exec.js":
            'import { exec } from "node:child_process";\nexport const runShell = (command) => exec(command, { windowsHide: true });\n',
        },
        MCP,
      );
      assert.equal(result.result.status, 2, result.result.stderr);
      assert.deepEqual(graded(result), [["RW-M01", "critical"]]);
      const found = finding(result, "RW-M01");
      assert.match(
        found.evidence.map((item) => item.claim).join("\n"),
        /exec\(\) creates a child process with a command REA did not resolve \([^)]*; in v1\.0\.0, Release Watch connected 1 tool registration to exec\(\) with a command REA did not resolve in src\/shell\.js\)/,
      );
      assert.ok(
        found.unknowns.includes(
          "v1.0.0 had an exec() with an unresolved command in src/shell.js that is gone now; this may be the same call, moved.",
        ),
        found.unknowns.join("\n"),
      );
    });
  },
);
