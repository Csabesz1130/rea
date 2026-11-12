// Marks a hand reading of real products corrected, each in the shape the
// product ships it (README, "On real products"), with REA's real facts.
// Skipped when REA has not been built.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { cell, landscape, skip, written } from "./cli-run.mjs";

const rowOf = (report, id) => report.rows.find((row) => row.id === id);
const claimsOf = (report, id, product) =>
  rowOf(report, id).cells[product].evidence.map((line) => line.claim);

describe(
  "map: telemetry named by the variable that holds its address",
  { skip },
  () => {
    const products = written();
    after(() => products.cleanup());

    it("marks a request likely telemetry when the name it reads says so, whatever the host", () => {
      // As skills 1.8.1 reports each command (dist/_chunks/remove.mjs).
      const named = products.write("installer", "1.0.0", {
        "index.js":
          'const TELEMETRY_URL = "https://www.tools.example/tele/t";\nexport function track(data) {\n  const params = new URLSearchParams(data);\n  fetch(`${TELEMETRY_URL}?${params.toString()}`).catch(() => {});\n}\n',
      });
      // The name the address is assigned to counts when an import renames it.
      const renamed = products.write("reporter", "1.0.0", {
        "src/endpoints.js":
          'export const ENDPOINTS = { analytics: "https://collect.tools.example/v1" };\n',
        "index.js":
          'import { ENDPOINTS as E } from "./src/endpoints.js";\nexport const send = (event) => fetch(E.analytics, { method: "POST", body: event });\n',
      });
      // A name that says nothing, and one that only holds the word's letters.
      const plain = products.write("fetcher", "1.0.0", {
        "index.js":
          'const REGISTRY_URL = "https://www.tools.example/registry";\nconst TELEMETRYLESS_URL = "https://www.tools.example/plain";\nexport const list = (query) => fetch(`${REGISTRY_URL}?q=${query}`);\nexport const plain = () => fetch(TELEMETRYLESS_URL);\n',
      });
      const run = landscape("map", [named, renamed, plain]);
      products.keep(run.out);
      assert.equal(run.result.status, 0, run.result.stderr);
      for (const label of [
        "installer 1.0.0",
        "reporter 1.0.0",
        "fetcher 1.0.0",
      ])
        assert.equal(cell(run.report, "data.remote", label), "yes", label);
      assert.equal(
        cell(run.report, "data.telemetry", "installer 1.0.0"),
        "likely",
      );
      assert.equal(
        cell(run.report, "data.telemetry", "reporter 1.0.0"),
        "likely",
      );
      assert.equal(cell(run.report, "data.telemetry", "fetcher 1.0.0"), "no");
      assert.deepEqual(claimsOf(run.report, "data.telemetry", "p1"), [
        "the request's address is held in TELEMETRY_URL, a name that says telemetry (Landscape's catalog)",
        "a request reads TELEMETRY_URL, which holds https://www.tools.example/tele/t",
      ]);
      assert.match(
        claimsOf(run.report, "data.telemetry", "p2")[0],
        /^the request's address is held in E\.analytics, a name that says analytics/,
      );
      assert.deepEqual(rowOf(run.report, "data.telemetry").cells.p1.values, [
        "www.tools.example",
      ]);
    });
  },
);

describe("map: a package loaded through a variable", { skip }, () => {
  const products = written();
  after(() => products.cleanup());

  it("reads the package a constant specifier names, and nothing from a variable REA cannot settle", () => {
    // As @google/gemini-cli-core 0.68.0 loads node-pty (utils/getPty.js).
    const constant = products.write("agent-a", "1.0.0", {
      "index.js":
        'export const getPty = async () => {\n  try {\n    const lydell = "@lydell/node-pty";\n    const module = await import(lydell);\n    return { module, name: "lydell-node-pty" };\n  } catch {\n    return null;\n  }\n};\n',
    });
    const dynamic = products.write("agent-b", "1.0.0", {
      "index.js":
        'export const load = async (name) => import(name);\nexport const run = () => load("node-pty");\n',
    });
    const run = landscape("map", [constant, dynamic]);
    products.keep(run.out);
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.equal(cell(run.report, "system.terminal", "agent-a 1.0.0"), "yes");
    assert.deepEqual(claimsOf(run.report, "system.terminal", "p1"), [
      "index.js loads @lydell/node-pty (import(lydell), where REA reports lydell constant), which runs programs in a pseudo-terminal (Landscape's catalog)",
    ]);
    assert.equal(
      rowOf(run.report, "system.terminal").cells.p1.evidence[0].basis,
      "derived",
    );
    // node-pty also starts processes REA does not model.
    assert.equal(cell(run.report, "system.process", "agent-a 1.0.0"), "likely");
    assert.equal(cell(run.report, "system.shell", "agent-a 1.0.0"), "unknown");
    for (const row of ["system.terminal", "system.process"])
      assert.equal(cell(run.report, row, "agent-b 1.0.0"), "no", row);
  });
});

describe("map: an agent's own model and MCP libraries", { skip }, () => {
  const products = written();
  after(() => products.cleanup());

  it("reads pi's MCP client library as a client and lists both among the building blocks", () => {
    // As @earendil-works/pi-coding-agent 1.5.2 calls models and MCP servers.
    const pi = products.write("agent-c", "1.0.0", {
      "index.js":
        'import { complete } from "@earendil-works/pi-ai";\nimport { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";\nexport const connect = async (url) => {\n  const client = new McpClient({ name: "agent-c", version: "1.0.0" });\n  await client.connect(new StreamableHttpTransport({ url }));\n  return client;\n};\nexport const ask = (model, prompt) => complete(model, prompt);\n',
    });
    // A package of another kind in the same scope says nothing.
    const other = products.write("agent-d", "1.0.0", {
      "index.js":
        'import { Text } from "@earendil-works/pi-tui";\nexport const render = (value) => new Text(value);\n',
    });
    const run = landscape("map", [pi, other]);
    products.keep(run.out);
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.equal(cell(run.report, "agent.mcp-client", "agent-c 1.0.0"), "yes");
    assert.deepEqual(claimsOf(run.report, "agent.mcp-client", "p1"), [
      "index.js imports @earendil-works/pi-mcp, an MCP client library",
    ]);
    assert.equal(cell(run.report, "agent.mcp-client", "agent-d 1.0.0"), "no");
    assert.equal(
      cell(run.report, "agent.mcp-server", "agent-c 1.0.0"),
      "absent",
    );
    const [first, second] = run.report.products;
    assert.deepEqual(
      first.stack.sdks.map(({ name, kind }) => [name, kind]),
      [
        ["@earendil-works/pi-ai", "ai"],
        ["@earendil-works/pi-mcp", "mcp"],
      ],
    );
    assert.deepEqual(second.stack.sdks, []);
    // It calls whichever provider it is configured for: no provider is read.
    assert.equal(cell(run.report, "ai.hosted", "agent-c 1.0.0"), "absent");
  });
});

describe(
  "map: a provider key under a name of the product's own",
  { skip },
  () => {
    const products = written();
    after(() => products.cleanup());

    it("marks a key read beside a provider's address likely, and no other key", () => {
      // As @vibe-kit/grok-cli 0.0.34 reads its key (dist/utils/settings-manager.js).
      const beside = products.write("agent-e", "1.0.0", {
        "settings.js":
          'const DEFAULTS = { baseURL: "https://api.x.ai/v1" };\nexport const apiKey = () => process.env.GROK_API_KEY;\nexport const baseURL = () => DEFAULTS.baseURL;\n',
        // A key of the same shape with no provider's address beside it.
        "editor.js":
          'export const morphKey = () => process.env.MORPH_API_KEY;\nexport const home = "https://docs.tools.example/editor";\n',
      });
      // Beside a provider's address, a variable that is not shaped like a key.
      const other = products.write("agent-f", "1.0.0", {
        "index.js":
          'export const endpoint = "https://api.x.ai/v1";\nexport const model = () => process.env.GROK_MODEL;\n',
      });
      const documented = products.write("agent-g", "1.0.0", {
        "index.js": "export const key = () => process.env.XAI_API_KEY;\n",
      });
      const run = landscape("map", [beside, other, documented]);
      products.keep(run.out);
      assert.equal(run.result.status, 0, run.result.stderr);
      assert.equal(
        cell(run.report, "ai.environment-key", "agent-e 1.0.0"),
        "likely",
      );
      assert.deepEqual(
        rowOf(run.report, "ai.environment-key").cells.p1.values,
        ["GROK_API_KEY"],
      );
      assert.deepEqual(claimsOf(run.report, "ai.environment-key", "p1"), [
        "settings.js reads GROK_API_KEY from the environment and holds https://api.x.ai/v1, xAI's API; GROK_API_KEY is not a name the catalog holds for a provider (a guess)",
      ]);
      assert.equal(
        cell(run.report, "ai.environment-key", "agent-f 1.0.0"),
        "no",
      );
      assert.equal(
        cell(run.report, "ai.environment-key", "agent-g 1.0.0"),
        "yes",
      );
    });
  },
);
