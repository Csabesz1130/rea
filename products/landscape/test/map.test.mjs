// Runs `landscape map` on fixture products with the REA build in this
// checkout. Skipped when REA has not been built.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, before, describe, it } from "node:test";

import { cell, fixture, landscape, skip, written } from "./cli-run.mjs";

const LABELS = ["notes-a 1.0.0", "notes-b 2.1.0", "notes-c 0.9.0"];
const OURS = "notes-ours 0.1.0";

// One map of the fixtures, run once for the suites that read it.
let mapped = null;
const fixtureMap = () => {
  mapped ??= landscape(
    "map",
    [fixture("notes-a"), fixture("notes-b"), fixture("notes-c")],
    ["--ours", fixture("notes-ours"), "--category", "Commit helpers"],
  );
  return mapped;
};
after(() => {
  if (mapped) rmSync(mapped.out, { recursive: true, force: true });
});

describe("map: three products and ours", { skip }, () => {
  let run;
  before(() => {
    run = fixtureMap();
  });

  it("maps every product REA examined in full", () => {
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.deepEqual(
      run.report.products.map((product) => [
        product.label,
        product.role,
        product.coverage.status,
      ]),
      [
        ...LABELS.map((label) => [label, "competitor", "complete"]),
        [OURS, "ours", "complete"],
      ],
    );
  });

  it("marks each product's traits from REA's facts", () => {
    const expected = {
      "ai.provider:OpenAI": ["yes", "yes", "no", "no"],
      "ai.provider:Anthropic": ["no", "yes", "yes", "no"],
      "ai.multi-provider": ["no", "yes", "no", "no"],
      "ai.local-model": ["no", "yes", "no", "yes"],
      "ai.environment-key": ["yes", "no", "no", "no"],
      "agent.mcp-server": ["no", "no", "yes", "no"],
      "agent.mcp-client": ["no", "no", "no", "yes"],
      "agent.tool-process": ["no", "no", "yes", "no"],
      "system.process": ["yes", "yes", "yes", "yes"],
      "system.shell": ["yes", "no", "yes", "no"],
      "data.remote": ["yes", "yes", "yes", "no"],
      "data.telemetry": ["yes", "no", "no", "no"],
      "data.update-check": ["no", "no", "yes", "no"],
    };
    for (const [row, states] of Object.entries(expected))
      assert.deepEqual(
        [...LABELS, OURS].map((label) => cell(run.report, row, label)),
        states,
        row,
      );
  });

  it("says what the products do together, without counting ours", () => {
    assert.deepEqual(run.report.summary.universal, [
      "ai.hosted",
      "system.process",
      "data.remote",
    ]);
    assert.deepEqual(run.report.summary.common, [
      "ai.provider:Anthropic",
      "ai.provider:OpenAI",
    ]);
    assert.deepEqual(
      run.report.summary.distinct.map(({ row }) => row),
      [
        "ai.multi-provider",
        "ai.local-model",
        "ai.environment-key",
        "agent.mcp-server",
        "data.update-check",
      ],
    );
    assert.deepEqual(run.report.summary.risks, [
      "system.shell",
      "agent.tool-process",
      "data.telemetry",
    ]);
  });

  it("suggests the openings the counts support", () => {
    assert.deepEqual(
      run.report.openings.map((opening) => [opening.id, opening.kind]),
      [
        ["local-first", "white space"],
        ["any-model", "white space"],
        ["no-telemetry", "inversion"],
        ["no-shell", "inversion"],
        ["narrow-tools", "inversion"],
        ["interactive", "white space"],
      ],
    );
    const [local] = run.report.openings;
    assert.equal(
      local.finding,
      "3 of 3 send prompts to a hosted model; 1 of 3 runs on a local one.",
    );
    assert.match(run.result.stdout, /Openings:\n {2}1\. Local-first AI/);
  });
});

describe("map: ours, the brief and the analyst's reports", { skip }, () => {
  let run;
  before(() => {
    run = fixtureMap();
  });

  it("places ours against them", () => {
    assert.deepEqual(run.report.position, {
      matches: ["system.process"],
      gaps: [
        "ai.provider:Anthropic",
        "ai.provider:OpenAI",
        "ai.hosted",
        "data.remote",
      ],
      edges: ["agent.mcp-client"],
      risks: [],
      clear: ["system.shell"],
    });
  });
  it("keeps code, commands and file paths out of the brief", () => {
    const brief = run.outputs["brief.md"];
    for (const text of [
      "git diff",
      "index.js",
      "server.js",
      "chat/completions",
      "OPENAI_URL",
      "registerTool",
      "Bearer",
    ])
      assert.ok(!brief.includes(text), `brief.md holds ${text}`);
    assert.match(brief, /`OPENAI_API_KEY` \(1 of 3\)/);
    assert.match(brief, /## Openings\n\n1\. \*\*Local-first AI\*\*/);
    assert.match(
      brief,
      /## notes-ours 0\.1\.0: only you do this\n\n- Connects to MCP servers/,
    );
  });

  it("cites the evidence behind each mark in the analyst's reports", () => {
    const html = run.outputs["report.html"];
    assert.match(
      html,
      /registerTool\(\) call at server\.js:13 reaches exec\(\) at server\.js:10/,
    );
    assert.match(html, /id="ev-system_shell-p1"/);
    assert.match(
      run.outputs["report.md"],
      /exec\(\) child-process creation running "git diff --cached"; exec\(\) runs its command in a shell `index\.js:16`/,
    );
  });
});

describe("map: what REA's facts cannot settle", { skip }, () => {
  const products = written();
  after(() => products.cleanup());

  it("leaves a trait unknown where a library REA does not model may show it", () => {
    const shellOut = products.write("runner-a", "1.0.0", {
      "index.js":
        'import { exec } from "node:child_process";\nexport const run = (command) => exec(command);\n',
    });
    const library = products.write("runner-b", "1.0.0", {
      "index.js":
        'import { execa } from "execa";\nexport const run = (command) => execa(command, { shell: true });\n',
    });
    // The MCP SDK's stdio client transport spawns the server it connects to.
    const client = products.write("mcp-client", "1.0.0", {
      "index.js":
        'import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";\nexport const connect = (command) => new StdioClientTransport({ command });\n',
    });
    const run = landscape("map", [shellOut, library, client]);
    products.keep(run.out);
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.equal(
      cell(run.report, "system.process", "runner-b 1.0.0"),
      "likely",
    );
    assert.equal(cell(run.report, "system.shell", "runner-b 1.0.0"), "unknown");
    const row = run.report.rows.find(
      (candidate) => candidate.id === "system.shell",
    );
    assert.deepEqual(row.cells.p2.reasons, [
      "it starts processes through execa, whose shell use REA does not model",
    ]);
    assert.equal(
      cell(run.report, "system.process", "mcp-client 1.0.0"),
      "likely",
    );
    assert.deepEqual(row.cells.p3.reasons, [
      "it starts processes through @modelcontextprotocol/sdk/client/stdio, whose shell use REA does not model",
    ]);
    assert.deepEqual(row.counts, {
      yes: 1,
      likely: 0,
      no: 0,
      unknown: 2,
      held: 1,
    });
  });

  it("fails closed for a product REA could not analyze", () => {
    const app = products.write("runner-c", "1.0.0", {
      "index.js":
        'export const run = () => fetch("https://api.example.com/run");\n',
    });
    const run = landscape("map", [app, fixture("empty")]);
    products.keep(run.out);
    assert.equal(run.result.status, 1);
    const [, empty] = run.report.products;
    assert.equal(empty.coverage.status, "none");
    assert.equal(run.report.errors[0].product, "p2");
    assert.equal(cell(run.report, "data.remote", "runner-c 1.0.0"), "yes");
    assert.equal(cell(run.report, "data.remote", empty.label), "unknown");
  });
});

describe("map: an MCP server SDK bundled into the code", { skip }, () => {
  const products = written();
  after(() => products.cleanup());

  it("reads a bundled tool-call dispatcher as likely, not a tool registry", () => {
    // What a bundler leaves of an MCP server: the SDK's request schema and
    // dispatcher inlined, with no import of the SDK.
    const bundled = products.write("bundled-server", "1.0.0", {
      "dist/bundle.js":
        'import { spawn } from "node:child_process";\nvar CallToolRequestSchema = { method: "tools/call" };\nclass Server { setRequestHandler(schema, handler) { this.handler = handler; } }\nconst server = new Server();\nserver.setRequestHandler(CallToolRequestSchema, async () => spawn("gcloud", ["info"]));\n',
    });
    // An agent's own tool registry, as an MCP client keeps one.
    const registry = products.write("agent-registry", "1.0.0", {
      "index.js":
        'import { spawn } from "node:child_process";\nclass ToolRegistry { registerTool(tool) { this.tool = tool; } }\nexport const tools = new ToolRegistry();\ntools.registerTool({ run: () => spawn("git", ["status"]) });\n',
    });
    const run = landscape("map", [bundled, registry]);
    products.keep(run.out);
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.equal(
      cell(run.report, "agent.mcp-server", "bundled-server 1.0.0"),
      "likely",
    );
    assert.equal(
      cell(run.report, "agent.tool-process", "bundled-server 1.0.0"),
      "unknown",
    );
    for (const row of ["agent.mcp-server", "agent.tool-process"])
      assert.equal(cell(run.report, row, "agent-registry 1.0.0"), "no", row);
  });
});

describe("map: AI keys read from the environment", { skip }, () => {
  const products = written();
  after(() => products.cleanup());

  it("keeps a key read REA could not settle as likely, not absent", () => {
    const direct = products.write("keys-direct", "1.0.0", {
      "index.js": "export const key = () => process.env.GEMINI_API_KEY;\n",
    });
    // A helper that returns process.env[key] for a key it is given: REA
    // then cannot settle that a later process.env read is the variable's.
    const helper = products.write("keys-helper", "1.0.0", {
      "index.js":
        'export function mode() { if (process.env["GEMINI_API_KEY"]) return "key"; return "login"; }\nconst getEnv = (key) => process.env[key];\nexport const project = () => getEnv("GOOGLE_CLOUD_PROJECT");\n',
    });
    const run = landscape("map", [direct, helper]);
    products.keep(run.out);
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.equal(
      cell(run.report, "ai.environment-key", "keys-direct 1.0.0"),
      "yes",
    );
    assert.equal(
      cell(run.report, "ai.environment-key", "keys-helper 1.0.0"),
      "likely",
    );
  });
});

describe("map: browser storage", { skip }, () => {
  const products = written();
  after(() => products.cleanup());

  it("counts Web Storage and IndexedDB, not a database file", () => {
    const page = products.write("notes-web", "1.0.0", {
      "index.js":
        'export const save = (text) => localStorage.setItem("draft", text);\n',
    });
    const server = products.write("todos-server", "1.0.0", {
      "index.js":
        'import Database from "better-sqlite3";\nexport const open = () => new Database("todos.db");\n',
    });
    const run = landscape("map", [page, server]);
    products.keep(run.out);
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.equal(cell(run.report, "web.storage", "notes-web 1.0.0"), "yes");
    assert.equal(cell(run.report, "web.storage", "todos-server 1.0.0"), "no");
  });
});

describe("map: only code that runs with the product", { skip }, () => {
  const products = written();
  after(() => products.cleanup());

  it("leaves out tests, mocks and test helpers a package ships, not code in a test directory", () => {
    const shipped = products.write("runner-d", "1.0.0", {
      "index.js": "export const run = () => 1;\n",
      "index.test.js":
        'export const probe = () => fetch("https://api.openai.com/v1/models");\n',
      "loggers.test.circular.js":
        'export const probe = () => fetch("https://api.anthropic.com/v1/models");\n',
      "__mocks__/shell.js":
        'import { exec } from "node:child_process";\nexport const run = (command) => exec(command);\n',
      "test-utils/server.js":
        'export const ping = () => fetch("https://test-server.example/ping");\n',
    });
    const other = products.write("runner-e", "1.0.0", {
      "index.js":
        'import { exec } from "node:child_process";\nexport const run = (command) => exec(command);\n',
    });
    // The code that runs a project's tests is the product's own.
    const tester = products.write("runner-f", "1.0.0", {
      "utils/test/run.js":
        'import { spawn } from "node:child_process";\nexport const test = (scheme) => spawn("xcodebuild", ["test", "-scheme", scheme]);\n',
    });
    const run = landscape("map", [shipped, other, tester]);
    products.keep(run.out);
    assert.equal(run.result.status, 0, run.result.stderr);
    for (const row of ["system.process", "system.shell"])
      assert.equal(cell(run.report, row, "runner-d 1.0.0"), "no", row);
    assert.equal(cell(run.report, "system.process", "runner-f 1.0.0"), "yes");
    assert.deepEqual(
      run.report.rows.map((row) => row.id),
      ["system.process", "system.shell"],
    );
  });
});
