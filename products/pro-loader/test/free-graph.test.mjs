import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { graphSliceInput } from "../graph/contracts.mjs";
import { previewSlice } from "../graph/preview.mjs";
import { queryGraph, tokens } from "../graph/store.mjs";

const cli = fileURLToPath(new URL("../../../scripts/rea.mjs", import.meta.url));
const fixture = fileURLToPath(
  new URL(
    "../../slicer/test/fixtures/credentials-app.evidence.json",
    import.meta.url,
  ),
);
const exec = promisify(execFile);

test("unsigned CLI and MCP share an indexed exact path and an atomic, retryable daily neighborhood allowance", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "rea-free-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const store = join(tmp, "store");
  const home = join(tmp, "profile");
  const env = {
    ...process.env,
    REA_PRO_HOME: home,
    REA_PRO_CONFIG: join(home, "absent.json"),
  };
  const run = async (args) =>
    JSON.parse(
      (
        await exec(process.execPath, [cli, "pro", ...args, "--store", store], {
          env,
        })
      ).stdout,
    );
  const meta = await run(["index", fixture]);
  assert.equal(meta.nodes, 47);
  const plan = queryGraph(store, (db) =>
    db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT data FROM nodes WHERE json_extract(data,'$.label') COLLATE BINARY=? ORDER BY id",
      )
      .all("kube"),
  );
  assert.ok(plan.some((p) => p.detail.includes("exact_labels")));
  const result = await run(["search", "kube", "--kind", "function"]);
  const id = result.matches[0].id;
  assert.equal(result.matches[0].label, "kube");
  assert.deepEqual(
    (await run(["search", "kube", "--offset", "3"])).matches,
    [],
  );
  assert.deepEqual(
    (await run(["search", "absent", "--mode", "exact"])).matches,
    [],
  );
  assert.equal(
    (await run(["search", "absent"])).code,
    "SEMANTIC_SEARCH_REQUIRES_PRO",
  );
  assert.equal(
    (await run(["search", "kube", "--mode", "semantic"])).code,
    "SEMANTIC_SEARCH_REQUIRES_PRO",
  );
  const invalid = join(tmp, "bad.json");
  await writeFile(invalid, "{}");
  await assert.rejects(run(["index", invalid]));
  assert.deepEqual(await run(["stats"]), meta);
  const client = new Client({ name: "free-integration", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, "pro", "mcp", "--store", store],
      env,
      stderr: "pipe",
    }),
  );
  t.after(() => client.close());
  const names = (await client.listTools()).tools
    .map((tool) => tool.name)
    .sort();
  assert.deepEqual(names, ["graph_search", "graph_slice", "graph_stats"]);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, JSON.stringify(r));
    return JSON.parse(r.content[0].text);
  };
  assert.deepEqual(
    await call("graph_search", { query: "kube", kind: "function" }),
    result,
  );
  const bad = await client.callTool({
    name: "graph_slice",
    arguments: { id: "missing" },
  });
  assert.equal(bad.isError, true);
  const first = await call("graph_slice", { id, budget: 500 });
  assert.ok(first.nodes.some((n) => n.id === id));
  assert.ok(tokens(JSON.stringify(first)) <= 500);
  const concurrent = await Promise.all(
    [501, 502, 503, 504, 505].map((b) =>
      run(["slice", id, "--budget", String(b)]),
    ),
  );
  assert.equal(concurrent.filter((a) => a.nodes).length, 2);
  for (const rejected of concurrent.filter((r) => r.code)) {
    assert.equal(rejected.code, "FREE_DAILY_SLICE_LIMIT");
    assert.equal(rejected.indexed_nodes, 47);
  }
  assert.deepEqual(await run(["slice", id, "--budget", "500"]), first);
  assert.deepEqual(
    await call("graph_search", { query: "kube", kind: "function" }),
    result,
  );
  const tomorrow = new Date(Date.now() + 86400000);
  const previous = process.env.REA_PRO_HOME;
  try {
    process.env.REA_PRO_HOME = home;
    const next = previewSlice(
      store,
      graphSliceInput.parse({ id, budget: 506 }),
      tomorrow,
    );
    assert.ok(next.nodes);
  } finally {
    if (previous === undefined) delete process.env.REA_PRO_HOME;
    else process.env.REA_PRO_HOME = previous;
  }
});
