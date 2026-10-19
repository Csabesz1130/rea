// Runs the public CLI on small MCP servers each test writes, for what
// RW-M01 takes from the diff of process sites: a tool in a file both
// releases ship with the same content is not new (diff.mjs
// unchangedFiles), a tool's new site carries what RW-P01 says of it
// (process.mjs siteUnknowns), and a site in a pooled bundle is worded by
// the diff's status for it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
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

describe(
  "compare: a tool in a file both releases ship unchanged",
  { skip },
  () => {
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
  },
);

describe(
  "compare: what RW-M01 says of the sites a tool reaches",
  { skip },
  () => {
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
  },
);
